"""Parameterized database repositories, OS-protected credential vault integration, NVR registry, and audit helpers."""

from __future__ import annotations

import json
import os
import shutil
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from ai_engine.registry import BIOMETRIC_IDENTIFICATION_ENABLED
from backend.app.core.credentials import (
    CredentialVault,
    sanitize_secret_text,
    strip_uri_credentials,
)
from backend.app.core.errors import NotFoundError, PolicyViolationError, ValidationError
from backend.app.db.database import DatabaseManager, utc_now_iso
from video_processing.camera_connector import (
    build_effective_camera_uri,
    discover_local_videos,
    probe_camera_endpoint,
    redact_stream_uri,
    sanitize_log_text,
)
from video_processing.camera_drivers import get_camera_driver
from video_processing.ffmpeg_probe import extract_thumbnail, is_ffmpeg_available, probe_video_file
from video_processing.nvr_connector import get_nvr_adapter, test_single_nvr_channel
from video_processing.opencv_reader import get_opencv_status

ALLOWED_SETTING_KEYS = {
    "storage_directory",
    "thumbnail_directory",
    "max_storage_quota_gb",
    "default_retention_days",
    "privacy_blur_default",
    "privacy_mask_mode",
    "detection_confidence_threshold",
    "detection_sample_fps",
    "require_consent_for_profiles",
    "log_level",
    "theme",
    "max_concurrent_streams",
    "max_concurrent_recordings",
}


def _dir_size_bytes(directory: Path) -> int:
    if not directory.exists():
        return 0
    total = 0
    for item in directory.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                continue
    return total


class LumaFluxRepository:
    def __init__(self, db: DatabaseManager) -> None:
        self.db = db
        vault_dir = os.getenv("LUMAFLUX_VAULT_DIR", "").strip()
        self.vault = CredentialVault(Path(vault_dir) if vault_dir else db.config.db_path.parent)

    def get_directories(self) -> tuple[Path, Path]:
        settings = self.get_settings()
        storage_dir = Path(settings.get("storage_directory", str(self.db.config.storage_dir)))
        thumb_dir = Path(settings.get("thumbnail_directory", str(self.db.config.thumbnail_dir)))
        storage_dir.mkdir(parents=True, exist_ok=True)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        return storage_dir, thumb_dir

    def write_audit_log(
        self,
        actor: str,
        actor_role: str,
        action: str,
        resource_type: str,
        details: str,
        resource_id: str | None = None,
        outcome: str = "success",
        source_ip: str = "127.0.0.1",
    ) -> dict[str, Any]:
        entry_id = str(uuid.uuid4())
        created_at = utc_now_iso()
        clean_details = sanitize_secret_text(details)
        with self.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO audit_logs
                  (id, actor, actor_role, action, resource_type, resource_id, details, outcome, source_ip, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (entry_id, actor, actor_role, action, resource_type, resource_id, clean_details, outcome, source_ip, created_at),
            )
            row = conn.execute("SELECT * FROM audit_logs WHERE id = ?", (entry_id,)).fetchone()
        return dict(row)

    def get_settings(self) -> dict[str, str]:
        with self.db.connection() as conn:
            rows = conn.execute("SELECT key, value FROM app_settings ORDER BY key").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def update_settings(self, updates: dict[str, Any]) -> dict[str, str]:
        now = utc_now_iso()
        updated_keys: list[str] = []
        with self.db.connection() as conn:
            for raw_key, raw_value in updates.items():
                key = str(raw_key).strip()
                if key not in ALLOWED_SETTING_KEYS or raw_value is None:
                    continue
                val_str = str(raw_value).strip()
                if "\x00" in val_str:
                    raise ValidationError(f"Invalid null byte in setting '{key}'.")
                if key in ("storage_directory", "thumbnail_directory"):
                    resolved = Path(val_str).expanduser().resolve()
                    try:
                        resolved.mkdir(parents=True, exist_ok=True)
                    except OSError as exc:
                        raise ValidationError(f"Cannot create directory '{resolved}': {exc}") from exc
                    val_str = str(resolved)
                conn.execute(
                    """
                    INSERT INTO app_settings (key, value, category, description, updated_at)
                    VALUES (?, ?, 'custom', 'User configured preference', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                    """,
                    (key, val_str, now),
                )
                updated_keys.append(key)

        if updated_keys:
            self.write_audit_log(
                actor="Local Administrator",
                actor_role="admin",
                action="SETTINGS_UPDATED",
                resource_type="app_settings",
                details=f"Updated settings: {', '.join(sorted(updated_keys))}",
            )
        return self.get_settings()

    def _format_camera(self, row: Any) -> dict[str, Any]:
        item = dict(row)
        item["enabled"] = bool(item["enabled"])
        item["stream_uri_masked"] = redact_stream_uri(item.get("stream_uri", ""))
        item["stream_uri"] = item["stream_uri_masked"]
        if item.get("main_stream_uri"):
            item["main_stream_uri"] = redact_stream_uri(item["main_stream_uri"])
        if item.get("sub_stream_uri"):
            item["sub_stream_uri"] = redact_stream_uri(item["sub_stream_uri"])

        cred_ref = item.pop("credential_ref", None)
        item["has_credentials"] = bool(cred_ref and self.vault.has_secret(cred_ref))

        stages_raw = item.pop("verification_stages_json", None)
        if stages_raw:
            try:
                item["verification_stages"] = json.loads(stages_raw)
            except Exception:
                item["verification_stages"] = None
        else:
            item["verification_stages"] = None

        driver_id = item.get("vendor_driver") or "standard_onvif"
        item["vendor_driver"] = driver_id
        caps_raw = item.pop("capabilities_json", None)
        if caps_raw:
            try:
                item["capabilities"] = json.loads(caps_raw)
            except Exception:
                item["capabilities"] = asdict(get_camera_driver(driver_id).capabilities)
        else:
            item["capabilities"] = asdict(get_camera_driver(driver_id).capabilities)
        return item

    def list_cameras(self) -> list[dict[str, Any]]:
        with self.db.connection() as conn:
            rows = conn.execute("SELECT * FROM cameras ORDER BY created_at DESC").fetchall()
            result: list[dict[str, Any]] = []
            for row in rows:
                formatted = self._format_camera(row)
                active_stream = conn.execute(
                    "SELECT id FROM camera_stream_sessions WHERE camera_id = ? AND status IN ('starting','streaming','reconnecting') ORDER BY started_at DESC LIMIT 1",
                    (row["id"],),
                ).fetchone()
                active_rec = conn.execute(
                    "SELECT id FROM recording_sessions WHERE camera_id = ? AND status = 'recording' ORDER BY started_at DESC LIMIT 1",
                    (row["id"],),
                ).fetchone()
                formatted["active_stream_id"] = active_stream["id"] if active_stream else None
                formatted["active_recording_id"] = active_rec["id"] if active_rec else None
                result.append(formatted)
        return result

    def resolve_camera_runtime(self, camera_id: str) -> tuple[dict[str, Any], str, str]:
        """Return (raw_row, runtime_uri_with_secret, rtsp_transport) strictly in memory."""
        with self.db.connection() as conn:
            row = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Camera {camera_id} not found.")
        cam = dict(row)
        password = self.vault.get_secret(cam.get("credential_ref"))
        runtime_uri = build_effective_camera_uri(
            source_type=cam["source_type"],
            stream_uri=cam["stream_uri"],
            main_stream_uri=cam.get("main_stream_uri"),
            sub_stream_uri=cam.get("sub_stream_uri"),
            stream_profile=cam.get("stream_profile") or "main",
            username=cam.get("username"),
            password=password,
        )
        transport = "udp" if str(cam.get("rtsp_transport") or "tcp").lower() == "udp" else "tcp"
        return cam, runtime_uri, transport

    def create_camera(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = (payload.get("name") or "").strip()
        location_zone = (payload.get("location_zone") or "").strip()
        source_type = payload.get("source_type") or "rtsp"
        if source_type not in ("rtsp", "onvif", "http", "local_archive"):
            source_type = "rtsp"

        ip_address = (payload.get("ip_address") or "").strip() or None
        rtsp_port = min(max(int(payload.get("rtsp_port") or 554), 1), 65535)
        onvif_port = min(max(int(payload.get("onvif_port") or 80), 1), 65535)
        rtsp_transport = "udp" if str(payload.get("rtsp_transport") or "tcp").lower() == "udp" else "tcp"
        stream_profile = "sub" if str(payload.get("stream_profile") or "main").lower() == "sub" else "main"
        timeout_sec = min(max(float(payload.get("connection_timeout_sec") or 6.0), 1.5), 30.0)

        raw_uri = (payload.get("stream_uri") or "").strip()
        if not raw_uri and ip_address:
            if source_type == "onvif":
                raw_uri = f"http://{ip_address}:{onvif_port}/onvif/device_service"
            elif source_type == "rtsp":
                raw_uri = f"rtsp://{ip_address}:{rtsp_port}/stream1"
            elif source_type == "http":
                raw_uri = f"http://{ip_address}:{onvif_port}/video"

        if not name or not location_zone or not raw_uri:
            raise ValidationError("Camera name, location_zone, and stream_uri (or ip_address) are required.")

        clean_uri, uri_user, uri_pass = (
            (raw_uri, None, None) if source_type == "local_archive" else strip_uri_credentials(raw_uri)
        )
        raw_main = (payload.get("main_stream_uri") or "").strip() or None
        raw_sub = (payload.get("sub_stream_uri") or "").strip() or None
        clean_main, m_user, m_pass = strip_uri_credentials(raw_main) if raw_main else (None, None, None)
        clean_sub, s_user, s_pass = strip_uri_credentials(raw_sub) if raw_sub else (None, None, None)

        if not ip_address and source_type != "local_archive":
            parsed = urlparse(clean_uri)
            if parsed.hostname:
                ip_address = parsed.hostname

        username = (payload.get("username") or "").strip() or uri_user or m_user or s_user or None
        raw_password = payload.get("password")
        if raw_password is None:
            raw_password = uri_pass or m_pass or s_pass
        elif isinstance(raw_password, str) and not raw_password:
            raw_password = uri_pass or m_pass or s_pass

        cam_id = str(uuid.uuid4())
        cred_ref: Optional[str] = None
        if raw_password:
            cred_ref = f"cam:{cam_id}"
            self.vault.set_secret(cred_ref, str(raw_password))

        now = utc_now_iso()
        retention = min(max(int(payload.get("retention_days") or 30), 1), 3650)
        recording_mode = payload.get("recording_mode") or "manual"
        if recording_mode not in ("manual", "scheduled", "motion_trigger", "continuous"):
            recording_mode = "manual"
        max_reconnect = min(max(int(payload.get("max_reconnect_attempts") or 5), 0), 50)
        target_fps = min(max(float(payload.get("target_fps") or 5.0), 0.5), 30.0)
        target_res = (payload.get("target_resolution") or "1280x720").strip() or "1280x720"
        schedule = payload.get("recording_schedule")
        nvr_id = payload.get("nvr_id") or None
        channel_number = payload.get("channel_number")
        driver = get_camera_driver(payload.get("vendor_driver"))
        vendor_driver = driver.id
        caps_json = json.dumps(asdict(driver.capabilities))

        with self.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO cameras
                  (id, name, location_zone, source_type, vendor_driver, capabilities_json, stream_uri, ip_address, rtsp_port, onvif_port,
                   username, credential_ref, rtsp_transport, stream_profile, main_stream_uri, sub_stream_uri,
                   connection_timeout_sec, nvr_id, channel_number, status, enabled, retention_days, recording_mode,
                   max_reconnect_attempts, target_fps, target_resolution, recording_schedule, last_checked_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                """,
                (
                    cam_id,
                    name,
                    location_zone,
                    source_type,
                    vendor_driver,
                    caps_json,
                    clean_uri,
                    ip_address,
                    rtsp_port,
                    onvif_port,
                    username,
                    cred_ref,
                    rtsp_transport,
                    stream_profile,
                    clean_main,
                    clean_sub,
                    timeout_sec,
                    nvr_id,
                    channel_number,
                    1 if payload.get("enabled", True) else 0,
                    retention,
                    recording_mode,
                    max_reconnect,
                    target_fps,
                    target_res,
                    schedule,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM cameras WHERE id = ?", (cam_id,)).fetchone()
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="CAMERA_CREATED",
            resource_type="camera",
            resource_id=cam_id,
            details=f"Configured camera '{name}' ({source_type}, {redact_stream_uri(clean_uri)}) in zone '{location_zone}'",
        )
        return self._format_camera(row)

    def update_camera(self, camera_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self.db.connection() as conn:
            existing = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()
            if not existing:
                raise NotFoundError(f"Camera {camera_id} not found.")
            now = utc_now_iso()
            next_enabled = int(bool(payload["enabled"])) if "enabled" in payload and payload["enabled"] is not None else existing["enabled"]
            next_status = payload.get("status") if payload.get("status") in ("configured", "online", "offline", "maintenance") else existing["status"]
            next_retention = min(max(int(payload.get("retention_days") or existing["retention_days"]), 1), 3650)

            raw_uri = (payload.get("stream_uri") or "").strip()
            uri_user = uri_pass = None
            if not raw_uri or raw_uri == redact_stream_uri(existing["stream_uri"]):
                next_uri = existing["stream_uri"]
            elif existing["source_type"] == "local_archive":
                next_uri = raw_uri
            else:
                next_uri, uri_user, uri_pass = strip_uri_credentials(raw_uri)

            next_main = existing["main_stream_uri"]
            m_user = m_pass = None
            if "main_stream_uri" in payload:
                val = (payload.get("main_stream_uri") or "").strip()
                if val and val != redact_stream_uri(existing["main_stream_uri"] or ""):
                    next_main, m_user, m_pass = strip_uri_credentials(val)
                elif not val:
                    next_main = None

            next_sub = existing["sub_stream_uri"]
            s_user = s_pass = None
            if "sub_stream_uri" in payload:
                val = (payload.get("sub_stream_uri") or "").strip()
                if val and val != redact_stream_uri(existing["sub_stream_uri"] or ""):
                    next_sub, s_user, s_pass = strip_uri_credentials(val)
                elif not val:
                    next_sub = None

            next_user = (
                (payload.get("username") or "").strip() or None
                if "username" in payload
                else (uri_user or m_user or s_user or existing["username"])
            )

            next_cred_ref = existing["credential_ref"]
            if payload.get("clear_password"):
                self.vault.delete_secret(next_cred_ref)
                next_cred_ref = None
            else:
                incoming_pass = payload.get("password")
                if not incoming_pass:
                    incoming_pass = uri_pass or m_pass or s_pass
                if incoming_pass:
                    next_cred_ref = next_cred_ref or f"cam:{camera_id}"
                    self.vault.set_secret(next_cred_ref, str(incoming_pass))

            next_ip = (payload.get("ip_address") or "").strip() or existing["ip_address"]
            next_rtsp_port = (
                min(max(int(payload["rtsp_port"]), 1), 65535)
                if "rtsp_port" in payload and payload["rtsp_port"] is not None
                else (existing["rtsp_port"] or 554)
            )
            next_onvif_port = (
                min(max(int(payload["onvif_port"]), 1), 65535)
                if "onvif_port" in payload and payload["onvif_port"] is not None
                else (existing["onvif_port"] or 80)
            )
            next_transport = (
                ("udp" if str(payload["rtsp_transport"]).lower() == "udp" else "tcp")
                if "rtsp_transport" in payload and payload["rtsp_transport"]
                else (existing["rtsp_transport"] or "tcp")
            )
            next_profile = (
                ("sub" if str(payload["stream_profile"]).lower() == "sub" else "main")
                if "stream_profile" in payload and payload["stream_profile"]
                else (existing["stream_profile"] or "main")
            )
            next_timeout = (
                min(max(float(payload["connection_timeout_sec"]), 1.5), 30.0)
                if "connection_timeout_sec" in payload and payload["connection_timeout_sec"] is not None
                else (existing["connection_timeout_sec"] or 6.0)
            )
            next_max_reconnect = (
                min(max(int(payload["max_reconnect_attempts"]), 0), 50)
                if "max_reconnect_attempts" in payload and payload["max_reconnect_attempts"] is not None
                else existing["max_reconnect_attempts"]
            )
            next_fps = (
                min(max(float(payload["target_fps"]), 0.5), 30.0)
                if "target_fps" in payload and payload["target_fps"] is not None
                else existing["target_fps"]
            )
            next_res = (payload.get("target_resolution") or existing["target_resolution"] or "1280x720").strip()
            next_schedule = payload["recording_schedule"] if "recording_schedule" in payload else existing["recording_schedule"]
            next_driver = (
                get_camera_driver(payload["vendor_driver"]).id
                if "vendor_driver" in payload and payload["vendor_driver"]
                else (existing["vendor_driver"] or "standard_onvif")
            )
            next_caps_json = json.dumps(asdict(get_camera_driver(next_driver).capabilities))

            conn.execute(
                """
                UPDATE cameras
                SET name = ?, location_zone = ?, vendor_driver = ?, capabilities_json = ?, stream_uri = ?, ip_address = ?, rtsp_port = ?, onvif_port = ?,
                    username = ?, credential_ref = ?, rtsp_transport = ?, stream_profile = ?, main_stream_uri = ?,
                    sub_stream_uri = ?, connection_timeout_sec = ?, status = ?, enabled = ?, retention_days = ?,
                    recording_mode = ?, max_reconnect_attempts = ?, target_fps = ?, target_resolution = ?,
                    recording_schedule = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    (payload.get("name") or existing["name"]).strip(),
                    (payload.get("location_zone") or existing["location_zone"]).strip(),
                    next_driver,
                    next_caps_json,
                    next_uri,
                    next_ip,
                    next_rtsp_port,
                    next_onvif_port,
                    next_user,
                    next_cred_ref,
                    next_transport,
                    next_profile,
                    next_main,
                    next_sub,
                    next_timeout,
                    next_status,
                    next_enabled,
                    next_retention,
                    payload.get("recording_mode") or existing["recording_mode"],
                    next_max_reconnect,
                    next_fps,
                    next_res,
                    next_schedule,
                    now,
                    camera_id,
                ),
            )
            row = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()

        item = self._format_camera(row)
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="CAMERA_UPDATED",
            resource_type="camera",
            resource_id=camera_id,
            details=f"Updated camera '{item['name']}' (status={item['status']}, enabled={item['enabled']})",
        )
        return item

    def check_camera(self, camera_id: str) -> dict[str, Any]:
        with self.db.connection() as conn:
            cam = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()
            if not cam:
                raise NotFoundError(f"Camera {camera_id} not found.")

            password = self.vault.get_secret(cam["credential_ref"])
            probe = probe_camera_endpoint(
                source_type=cam["source_type"],
                stream_uri=cam["stream_uri"],
                timeout_sec=float(cam["connection_timeout_sec"] or 6.0),
                rtsp_transport=cam["rtsp_transport"] or "tcp",
                username=cam["username"],
                password=password,
                stream_profile=cam["stream_profile"] or "main",
                main_stream_uri=cam["main_stream_uri"],
                sub_stream_uri=cam["sub_stream_uri"],
            )
            next_status = probe.status
            detail_msg = sanitize_log_text(probe.message, cam["stream_uri"], password)
            last_error = None if probe.reachable else detail_msg

            next_main = probe.main_stream_uri or cam["main_stream_uri"]
            next_sub = probe.sub_stream_uri or cam["sub_stream_uri"]
            stages_json = json.dumps(probe.stages) if probe.stages else cam["verification_stages_json"]
            now = utc_now_iso()
            conn.execute(
                """
                UPDATE cameras
                SET status = ?, last_checked_at = ?, last_error = ?,
                    device_manufacturer = COALESCE(?, device_manufacturer),
                    device_model = COALESCE(?, device_model),
                    firmware_version = COALESCE(?, firmware_version),
                    main_stream_uri = COALESCE(?, main_stream_uri),
                    sub_stream_uri = COALESCE(?, sub_stream_uri),
                    verification_stages_json = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    next_status,
                    now,
                    last_error,
                    probe.manufacturer,
                    probe.model,
                    probe.firmware_version,
                    next_main,
                    next_sub,
                    stages_json,
                    now,
                    camera_id,
                ),
            )
            updated = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()

        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="CAMERA_HEALTH_CHECKED",
            resource_type="camera",
            resource_id=camera_id,
            details=f"{cam['name']}: {detail_msg}",
            outcome="success" if probe.reachable else "error",
        )
        return {"camera": self._format_camera(updated), "message": detail_msg, "probe": probe.to_dict()}

    def stream_test_camera(self, camera_id: str) -> dict[str, Any]:
        res = self.check_camera(camera_id)
        probe = res["probe"]
        width = probe.get("width")
        height = probe.get("height")
        return {
            **res,
            "stream_reachable": bool(probe.get("reachable")),
            "codec": probe.get("codec"),
            "resolution": f"{width}x{height}" if width and height else None,
            "fps": probe.get("fps"),
        }

    def ingest_local_camera_videos(self, camera_id: str) -> list[dict[str, Any]]:
        import hashlib

        with self.db.connection() as conn:
            cam = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()
            if not cam:
                raise NotFoundError(f"Camera {camera_id} not found.")
            if cam["source_type"] != "local_archive":
                raise ValidationError("Local archive ingestion requires source_type='local_archive'.")

        files = discover_local_videos(cam["stream_uri"])
        if not files:
            raise ValidationError("No supported local video files found at configured archive path.")

        settings = self.get_settings()
        storage_dir = Path(settings.get("storage_directory", str(self.db.config.storage_dir)))
        thumb_dir = Path(settings.get("thumbnail_directory", str(self.db.config.thumbnail_dir)))
        storage_dir.mkdir(parents=True, exist_ok=True)
        thumb_dir.mkdir(parents=True, exist_ok=True)

        ingested: list[dict[str, Any]] = []
        for src_file in files:
            meta = probe_video_file(src_file)
            if not meta.codec and not meta.width:
                continue
            video_id = str(uuid.uuid4())
            dest_name = f"{video_id}{src_file.suffix.lower()}"
            dest_path = storage_dir / dest_name
            shutil.copy2(src_file, dest_path)

            digest = hashlib.sha256()
            with dest_path.open("rb") as fh:
                for chunk in iter(lambda: fh.read(65536), b""):
                    digest.update(chunk)
            sha256 = digest.hexdigest()

            thumb_path = thumb_dir / f"{video_id}.jpg"
            thumb_ok = extract_thumbnail(dest_path, thumb_path)
            now = utc_now_iso()

            with self.db.connection() as conn:
                conn.execute(
                    """
                    INSERT INTO video_files
                      (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes,
                       duration_seconds, width, height, fps, codec, processing_status, source_origin, imported_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'imported', ?)
                    """,
                    (
                        video_id,
                        camera_id,
                        dest_name,
                        src_file.name,
                        str(dest_path),
                        str(thumb_path) if thumb_ok else None,
                        sha256,
                        dest_path.stat().st_size,
                        meta.duration_seconds,
                        meta.width,
                        meta.height,
                        meta.fps,
                        meta.codec,
                        now,
                    ),
                )
                row = conn.execute(
                    "SELECT v.*, c.name AS camera_name FROM video_files v LEFT JOIN cameras c ON v.camera_id = c.id WHERE v.id = ?",
                    (video_id,),
                ).fetchone()
            ingested.append(dict(row))

        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="CAMERA_LOCAL_INGESTED",
            resource_type="camera",
            resource_id=camera_id,
            details=f"Ingested {len(ingested)} video file(s) from local source '{cam['name']}'",
        )
        return ingested

    def delete_camera(self, camera_id: str) -> None:
        with self.db.connection() as conn:
            existing = conn.execute("SELECT name, credential_ref FROM cameras WHERE id = ?", (camera_id,)).fetchone()
            if not existing:
                raise NotFoundError(f"Camera {camera_id} not found.")
            cred_ref = existing["credential_ref"]
            conn.execute("DELETE FROM cameras WHERE id = ?", (camera_id,))
        self.vault.delete_secret(cred_ref)
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="CAMERA_DELETED",
            resource_type="camera",
            resource_id=camera_id,
            details=f"Removed camera '{existing['name']}'",
        )

    # --- NVR & Channel Management ---

    def _format_nvr(self, row: Any) -> dict[str, Any]:
        item = dict(row)
        cred_ref = item.pop("credential_ref", None)
        item["has_credentials"] = bool(cred_ref and self.vault.has_secret(cred_ref))
        if item.get("rtsp_url_template"):
            item["rtsp_url_template"] = redact_stream_uri(item["rtsp_url_template"])
        return item

    def _format_nvr_channel(self, row: Any) -> dict[str, Any]:
        item = dict(row)
        item["enabled"] = bool(item["enabled"])
        item["main_stream_uri"] = redact_stream_uri(item.get("main_stream_uri") or "")
        if item.get("sub_stream_uri"):
            item["sub_stream_uri"] = redact_stream_uri(item["sub_stream_uri"])
        return item

    def list_nvrs(self) -> list[dict[str, Any]]:
        with self.db.connection() as conn:
            rows = conn.execute("SELECT * FROM nvrs ORDER BY created_at DESC").fetchall()
        return [self._format_nvr(r) for r in rows]

    def create_nvr(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = (payload.get("name") or "").strip()
        host = (payload.get("host") or "").strip()
        if not name or not host:
            raise ValidationError("NVR name and host IP/hostname are required.")
        adapter_type = payload.get("adapter_type") or "standard_onvif_rtsp"
        if adapter_type not in ("standard_onvif_rtsp", "generic_rtsp_channels"):
            adapter_type = "standard_onvif_rtsp"
        port = min(max(int(payload.get("port") or 80), 1), 65535)
        rtsp_port = min(max(int(payload.get("rtsp_port") or 554), 1), 65535)
        rtsp_transport = "udp" if str(payload.get("rtsp_transport") or "tcp").lower() == "udp" else "tcp"
        channel_count = min(max(int(payload.get("channel_count") or 0), 0), 256)
        username = (payload.get("username") or "").strip() or None
        password = payload.get("password") or None
        raw_tmpl = (payload.get("rtsp_url_template") or "").strip() or None
        clean_tmpl, t_user, t_pass = strip_uri_credentials(raw_tmpl) if raw_tmpl else (None, None, None)
        username = username or t_user
        password = password or t_pass

        nvr_id = str(uuid.uuid4())
        cred_ref: Optional[str] = None
        if password:
            cred_ref = f"nvr:{nvr_id}"
            self.vault.set_secret(cred_ref, str(password))

        now = utc_now_iso()
        with self.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO nvrs
                  (id, name, adapter_type, host, port, rtsp_port, username, credential_ref, rtsp_transport,
                   rtsp_url_template, channel_count, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?)
                """,
                (
                    nvr_id,
                    name,
                    adapter_type,
                    host,
                    port,
                    rtsp_port,
                    username,
                    cred_ref,
                    rtsp_transport,
                    clean_tmpl,
                    channel_count,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="NVR_CREATED",
            resource_type="nvr",
            resource_id=nvr_id,
            details=f"Configured NVR '{name}' ({adapter_type}, {host}:{port})",
        )
        return self._format_nvr(row)

    def delete_nvr(self, nvr_id: str) -> None:
        with self.db.connection() as conn:
            existing = conn.execute("SELECT name, credential_ref FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
            if not existing:
                raise NotFoundError(f"NVR {nvr_id} not found.")
            cred_ref = existing["credential_ref"]
            conn.execute("DELETE FROM nvrs WHERE id = ?", (nvr_id,))
        self.vault.delete_secret(cred_ref)
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="NVR_DELETED",
            resource_type="nvr",
            resource_id=nvr_id,
            details=f"Deleted NVR '{existing['name']}'",
        )

    def test_nvr(self, nvr_id: str) -> dict[str, Any]:
        with self.db.connection() as conn:
            nvr = conn.execute("SELECT * FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
            if not nvr:
                raise NotFoundError(f"NVR {nvr_id} not found.")
        password = self.vault.get_secret(nvr["credential_ref"])
        adapter = get_nvr_adapter(nvr["adapter_type"])
        res = adapter.test_connection(
            host=nvr["host"],
            port=int(nvr["port"]),
            rtsp_port=int(nvr["rtsp_port"]),
            username=nvr["username"],
            password=password,
            rtsp_transport=nvr["rtsp_transport"] or "tcp",
            rtsp_url_template=nvr["rtsp_url_template"],
            channel_count=int(nvr["channel_count"] or 0),
        )
        now = utc_now_iso()
        clean_msg = sanitize_secret_text(res.message, password)
        with self.db.connection() as conn:
            conn.execute(
                """
                UPDATE nvrs
                SET status = ?, last_checked_at = ?, last_error = ?,
                    device_manufacturer = COALESCE(?, device_manufacturer),
                    device_model = COALESCE(?, device_model),
                    firmware_version = COALESCE(?, firmware_version),
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    res.status,
                    now,
                    None if res.reachable else clean_msg,
                    res.manufacturer,
                    res.model,
                    res.firmware_version,
                    now,
                    nvr_id,
                ),
            )
            updated = conn.execute("SELECT * FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="NVR_TESTED",
            resource_type="nvr",
            resource_id=nvr_id,
            details=f"NVR '{nvr['name']}': {clean_msg}",
            outcome="success" if res.reachable else "error",
        )
        return {"nvr": self._format_nvr(updated), "probe": res.to_dict(), "message": clean_msg}

    def discover_nvr_channels(self, nvr_id: str) -> dict[str, Any]:
        with self.db.connection() as conn:
            nvr = conn.execute("SELECT * FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
            if not nvr:
                raise NotFoundError(f"NVR {nvr_id} not found.")
        password = self.vault.get_secret(nvr["credential_ref"])
        adapter = get_nvr_adapter(nvr["adapter_type"])
        outcome = adapter.discover_channels(
            host=nvr["host"],
            port=int(nvr["port"]),
            rtsp_port=int(nvr["rtsp_port"]),
            username=nvr["username"],
            password=password,
            rtsp_transport=nvr["rtsp_transport"] or "tcp",
            rtsp_url_template=nvr["rtsp_url_template"],
            channel_count=int(nvr["channel_count"] or 0),
        )
        now = utc_now_iso()
        clean_msg = sanitize_secret_text(outcome.message, password)

        with self.db.connection() as conn:
            for ch in outcome.channels:
                ch_clean_main, _, _ = strip_uri_credentials(ch.main_stream_uri)
                ch_clean_sub, _, _ = strip_uri_credentials(ch.sub_stream_uri) if ch.sub_stream_uri else (None, None, None)
                existing = conn.execute(
                    "SELECT id FROM nvr_channels WHERE nvr_id = ? AND channel_number = ?",
                    (nvr_id, ch.channel_number),
                ).fetchone()
                if existing:
                    conn.execute(
                        """
                        UPDATE nvr_channels
                        SET name = ?, profile_token = ?, main_stream_uri = ?, sub_stream_uri = ?,
                            width = ?, height = ?, fps = ?, codec = ?, status = ?, last_checked_at = ?, last_error = ?, updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            ch.name,
                            ch.profile_token,
                            ch_clean_main,
                            ch_clean_sub,
                            ch.width,
                            ch.height,
                            ch.fps,
                            ch.codec,
                            ch.status,
                            now,
                            sanitize_secret_text(ch.error or "", password) or None,
                            now,
                            existing["id"],
                        ),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO nvr_channels
                          (id, nvr_id, channel_number, name, profile_token, main_stream_uri, sub_stream_uri,
                           width, height, fps, codec, enabled, status, last_checked_at, last_error, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
                        """,
                        (
                            str(uuid.uuid4()),
                            nvr_id,
                            ch.channel_number,
                            ch.name,
                            ch.profile_token,
                            ch_clean_main,
                            ch_clean_sub,
                            ch.width,
                            ch.height,
                            ch.fps,
                            ch.codec,
                            ch.status,
                            now,
                            sanitize_secret_text(ch.error or "", password) or None,
                            now,
                            now,
                        ),
                    )
            total_ch = conn.execute("SELECT COUNT(*) AS c FROM nvr_channels WHERE nvr_id = ?", (nvr_id,)).fetchone()["c"]
            conn.execute(
                """
                UPDATE nvrs
                SET status = ?, channel_count = ?, last_checked_at = ?,
                    last_error = ?,
                    device_manufacturer = COALESCE(?, device_manufacturer),
                    device_model = COALESCE(?, device_model),
                    firmware_version = COALESCE(?, firmware_version),
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    outcome.nvr_status,
                    total_ch,
                    now,
                    None if outcome.nvr_status == "online" else clean_msg,
                    outcome.manufacturer,
                    outcome.model,
                    outcome.firmware_version,
                    now,
                    nvr_id,
                ),
            )
            updated_nvr = conn.execute("SELECT * FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
            ch_rows = conn.execute(
                "SELECT * FROM nvr_channels WHERE nvr_id = ? ORDER BY channel_number ASC", (nvr_id,)
            ).fetchall()

        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="NVR_CHANNELS_DISCOVERED",
            resource_type="nvr",
            resource_id=nvr_id,
            details=f"NVR '{nvr['name']}': {clean_msg}",
            outcome="success" if outcome.nvr_status == "online" else "error",
        )
        return {
            "nvr": self._format_nvr(updated_nvr),
            "channels": [self._format_nvr_channel(r) for r in ch_rows],
            "message": clean_msg,
        }

    def list_nvr_channels(self, nvr_id: str) -> list[dict[str, Any]]:
        with self.db.connection() as conn:
            nvr = conn.execute("SELECT id FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
            if not nvr:
                raise NotFoundError(f"NVR {nvr_id} not found.")
            rows = conn.execute(
                "SELECT * FROM nvr_channels WHERE nvr_id = ? ORDER BY channel_number ASC", (nvr_id,)
            ).fetchall()
        return [self._format_nvr_channel(r) for r in rows]

    def register_nvr_channel_as_camera(self, nvr_id: str, channel_id: str, location_zone: Optional[str] = None) -> dict[str, Any]:
        with self.db.connection() as conn:
            nvr = conn.execute("SELECT * FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
            ch = conn.execute(
                "SELECT * FROM nvr_channels WHERE id = ? AND nvr_id = ?", (channel_id, nvr_id)
            ).fetchone()
            if not nvr or not ch:
                raise NotFoundError("NVR or channel not found.")
            if ch["registered_camera_id"]:
                existing_cam = conn.execute("SELECT * FROM cameras WHERE id = ?", (ch["registered_camera_id"],)).fetchone()
                if existing_cam:
                    return self._format_camera(existing_cam)

        nvr_secret = self.vault.get_secret(nvr["credential_ref"])
        cam = self.create_camera(
            {
                "name": f"{nvr['name']} · {ch['name']}",
                "location_zone": (location_zone or nvr["name"]).strip(),
                "source_type": "rtsp",
                "vendor_driver": "standard_onvif" if nvr["adapter_type"] == "standard_onvif_rtsp" else "manual_rtsp",
                "stream_uri": ch["main_stream_uri"],
                "ip_address": nvr["host"],
                "rtsp_port": nvr["rtsp_port"],
                "onvif_port": nvr["port"],
                "username": nvr["username"],
                "password": nvr_secret,
                "rtsp_transport": nvr["rtsp_transport"],
                "main_stream_uri": ch["main_stream_uri"],
                "sub_stream_uri": ch["sub_stream_uri"],
                "nvr_id": nvr_id,
                "channel_number": ch["channel_number"],
                "target_resolution": f"{ch['width']}x{ch['height']}" if ch["width"] and ch["height"] else "1280x720",
            }
        )
        with self.db.connection() as conn:
            conn.execute(
                "UPDATE nvr_channels SET registered_camera_id = ?, updated_at = ? WHERE id = ?",
                (cam["id"], utc_now_iso(), channel_id),
            )
            conn.execute(
                "UPDATE cameras SET status = ?, device_manufacturer = ?, device_model = ? WHERE id = ?",
                (ch["status"], nvr["device_manufacturer"], nvr["device_model"], cam["id"]),
            )
            row = conn.execute("SELECT * FROM cameras WHERE id = ?", (cam["id"],)).fetchone()
        return self._format_camera(row)

    def create_manual_nvr_channel(self, nvr_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self.db.connection() as conn:
            nvr = conn.execute("SELECT * FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
            if not nvr:
                raise NotFoundError(f"NVR {nvr_id} not found.")
            ch_num = int(payload.get("channel_number") or 0)
            if ch_num < 1 or ch_num > 256:
                raise ValidationError("channel_number must be between 1 and 256.")
            name = (payload.get("name") or f"Channel {ch_num:02d}").strip()
            raw_main = (payload.get("main_stream_uri") or "").strip()
            if not raw_main:
                raise ValidationError("main_stream_uri is required.")
            clean_main, _, _ = strip_uri_credentials(raw_main)
            raw_sub = (payload.get("sub_stream_uri") or "").strip()
            clean_sub, _, _ = strip_uri_credentials(raw_sub) if raw_sub else (None, None, None)

            dup = conn.execute(
                "SELECT id FROM nvr_channels WHERE nvr_id = ? AND channel_number = ?", (nvr_id, ch_num)
            ).fetchone()
            if dup:
                raise ValidationError(f"Channel number {ch_num} already exists on this NVR.")

            ch_id = str(uuid.uuid4())
            now = utc_now_iso()
            conn.execute(
                """
                INSERT INTO nvr_channels
                  (id, nvr_id, channel_number, name, profile_token, main_stream_uri, sub_stream_uri,
                   enabled, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?)
                """,
                (
                    ch_id,
                    nvr_id,
                    ch_num,
                    name,
                    f"manual-ch{ch_num}",
                    clean_main,
                    clean_sub,
                    1 if payload.get("enabled", True) else 0,
                    now,
                    now,
                ),
            )
            total_ch = conn.execute("SELECT COUNT(*) AS c FROM nvr_channels WHERE nvr_id = ?", (nvr_id,)).fetchone()["c"]
            conn.execute("UPDATE nvrs SET channel_count = ?, updated_at = ? WHERE id = ?", (total_ch, now, nvr_id))
            row = conn.execute("SELECT * FROM nvr_channels WHERE id = ?", (ch_id,)).fetchone()
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="NVR_CHANNEL_ADDED",
            resource_type="nvr_channel",
            resource_id=ch_id,
            details=f"Manually added channel {ch_num} ('{name}') to NVR '{nvr['name']}'",
        )
        return self._format_nvr_channel(row)

    def test_nvr_channel(self, nvr_id: str, channel_id: str) -> dict[str, Any]:
        with self.db.connection() as conn:
            nvr = conn.execute("SELECT * FROM nvrs WHERE id = ?", (nvr_id,)).fetchone()
            ch = conn.execute(
                "SELECT * FROM nvr_channels WHERE id = ? AND nvr_id = ?", (channel_id, nvr_id)
            ).fetchone()
            if not nvr or not ch:
                raise NotFoundError("NVR or channel not found.")

        password = self.vault.get_secret(nvr["credential_ref"])
        res = test_single_nvr_channel(
            main_stream_uri=ch["main_stream_uri"],
            username=nvr["username"],
            password=password,
            rtsp_transport=nvr["rtsp_transport"] or "tcp",
        )
        now = utc_now_iso()
        with self.db.connection() as conn:
            conn.execute(
                """
                UPDATE nvr_channels
                SET status = ?, codec = COALESCE(?, codec), width = COALESCE(?, width),
                    height = COALESCE(?, height), fps = COALESCE(?, fps),
                    last_checked_at = ?, last_error = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    res["status"],
                    res["codec"],
                    res["width"],
                    res["height"],
                    res["fps"],
                    now,
                    res["error"],
                    now,
                    channel_id,
                ),
            )
            updated = conn.execute("SELECT * FROM nvr_channels WHERE id = ?", (channel_id,)).fetchone()
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="NVR_CHANNEL_TESTED",
            resource_type="nvr_channel",
            resource_id=channel_id,
            details=f"Channel {ch['channel_number']} ({ch['name']}): {res['message']}",
            outcome="success" if res["reachable"] else "error",
        )
        return {"channel": self._format_nvr_channel(updated), "test": res, "message": res["message"]}

    def update_nvr_channel(self, nvr_id: str, channel_id: str, enabled: bool) -> dict[str, Any]:
        with self.db.connection() as conn:
            ch = conn.execute(
                "SELECT * FROM nvr_channels WHERE id = ? AND nvr_id = ?", (channel_id, nvr_id)
            ).fetchone()
            if not ch:
                raise NotFoundError("NVR channel not found.")
            conn.execute(
                "UPDATE nvr_channels SET enabled = ?, updated_at = ? WHERE id = ?",
                (1 if enabled else 0, utc_now_iso(), channel_id),
            )
            updated = conn.execute("SELECT * FROM nvr_channels WHERE id = ?", (channel_id,)).fetchone()
        return self._format_nvr_channel(updated)

    # --- Gallery Collections ---

    def list_gallery_collections(self) -> list[dict[str, Any]]:
        with self.db.connection() as conn:
            cols = conn.execute("SELECT * FROM gallery_collections ORDER BY created_at DESC").fetchall()
            out: list[dict[str, Any]] = []
            for col in cols:
                items = conn.execute(
                    "SELECT event_id FROM gallery_collection_items WHERE collection_id = ? ORDER BY added_at DESC",
                    (col["id"],),
                ).fetchall()
                d = dict(col)
                d["event_ids"] = [r["event_id"] for r in items]
                d["item_count"] = len(d["event_ids"])
                out.append(d)
        return out

    def create_gallery_collection(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = (payload.get("name") or "").strip()
        if not name:
            raise ValidationError("Collection name is required.")
        col_id = str(uuid.uuid4())
        now = utc_now_iso()
        with self.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO gallery_collections (id, name, description, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (col_id, name, (payload.get("description") or "").strip(), now, now),
            )
            row = conn.execute("SELECT * FROM gallery_collections WHERE id = ?", (col_id,)).fetchone()
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="GALLERY_COLLECTION_CREATED",
            resource_type="gallery_collection",
            resource_id=col_id,
            details=f"Created event gallery collection '{name}'",
        )
        d = dict(row)
        d["event_ids"] = []
        d["item_count"] = 0
        return d

    def delete_gallery_collection(self, collection_id: str) -> None:
        with self.db.connection() as conn:
            existing = conn.execute("SELECT name FROM gallery_collections WHERE id = ?", (collection_id,)).fetchone()
            if not existing:
                raise NotFoundError("Gallery collection not found.")
            conn.execute("DELETE FROM gallery_collections WHERE id = ?", (collection_id,))
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="GALLERY_COLLECTION_DELETED",
            resource_type="gallery_collection",
            resource_id=collection_id,
            details=f"Deleted event gallery collection '{existing['name']}'",
        )

    def add_gallery_collection_item(self, collection_id: str, event_id: str) -> dict[str, Any]:
        now = utc_now_iso()
        with self.db.connection() as conn:
            col = conn.execute("SELECT * FROM gallery_collections WHERE id = ?", (collection_id,)).fetchone()
            if not col:
                raise NotFoundError("Gallery collection not found.")
            evt = conn.execute("SELECT id FROM person_events WHERE id = ?", (event_id,)).fetchone()
            if not evt:
                raise NotFoundError("Person event not found.")
            conn.execute(
                """
                INSERT OR IGNORE INTO gallery_collection_items (collection_id, event_id, added_at)
                VALUES (?, ?, ?)
                """,
                (collection_id, event_id, now),
            )
            conn.execute("UPDATE gallery_collections SET updated_at = ? WHERE id = ?", (now, collection_id))
            items = conn.execute(
                "SELECT event_id FROM gallery_collection_items WHERE collection_id = ? ORDER BY added_at DESC",
                (collection_id,),
            ).fetchall()
        d = dict(col)
        d["updated_at"] = now
        d["event_ids"] = [r["event_id"] for r in items]
        d["item_count"] = len(d["event_ids"])
        return d

    def remove_gallery_collection_item(self, collection_id: str, event_id: str) -> dict[str, Any]:
        now = utc_now_iso()
        with self.db.connection() as conn:
            col = conn.execute("SELECT * FROM gallery_collections WHERE id = ?", (collection_id,)).fetchone()
            if not col:
                raise NotFoundError("Gallery collection not found.")
            conn.execute(
                "DELETE FROM gallery_collection_items WHERE collection_id = ? AND event_id = ?",
                (collection_id, event_id),
            )
            conn.execute("UPDATE gallery_collections SET updated_at = ? WHERE id = ?", (now, collection_id))
            items = conn.execute(
                "SELECT event_id FROM gallery_collection_items WHERE collection_id = ? ORDER BY added_at DESC",
                (collection_id,),
            ).fetchall()
        d = dict(col)
        d["updated_at"] = now
        d["event_ids"] = [r["event_id"] for r in items]
        d["item_count"] = len(d["event_ids"])
        return d

    def list_videos(self) -> list[dict[str, Any]]:
        with self.db.connection() as conn:
            rows = conn.execute(
                """
                SELECT v.*, c.name AS camera_name
                FROM video_files v
                LEFT JOIN cameras c ON v.camera_id = c.id
                ORDER BY v.imported_at DESC
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def list_profiles(self) -> list[dict[str, Any]]:
        with self.db.connection() as conn:
            rows = conn.execute("SELECT * FROM person_profiles ORDER BY updated_at DESC").fetchall()
        return [dict(row) for row in rows]

    def create_profile(self, payload: dict[str, Any]) -> dict[str, Any]:
        display_name = (payload.get("display_name") or "").strip()
        if not display_name:
            raise ValidationError("display_name is required.")
        category = "authorized" if payload.get("category") == "authorized" else "anonymous"
        auth_level = payload.get("authorization_level")
        if auth_level not in ("authorized", "visitor", "restricted", "anonymous"):
            auth_level = "visitor" if category == "authorized" else "anonymous"
        consent_status = payload.get("consent_status")
        if consent_status not in ("granted", "pending", "revoked"):
            consent_status = "pending"

        settings = self.get_settings()
        if (
            settings.get("require_consent_for_profiles") == "true"
            and auth_level == "authorized"
            and consent_status != "granted"
        ):
            self.write_audit_log(
                actor="Local Administrator",
                actor_role="admin",
                action="PROFILE_POLICY_BLOCKED",
                resource_type="person_profile",
                details=f"Blocked creating authorized profile '{display_name}' without granted consent.",
                outcome="denied",
            )
            raise PolicyViolationError('Policy requires consent_status="granted" before assigning authorized status.')

        profile_id = str(uuid.uuid4())
        profile_code = f"LFX-{profile_id[:8].upper()}"
        now = utc_now_iso()
        consent_recorded_at = now if consent_status == "granted" else None

        with self.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO person_profiles
                  (id, profile_code, display_name, category, authorization_level, consent_status, consent_recorded_at, retention_expires_at, department_or_zone, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    profile_id,
                    profile_code,
                    display_name,
                    category,
                    auth_level,
                    consent_status,
                    consent_recorded_at,
                    payload.get("retention_expires_at"),
                    (payload.get("department_or_zone") or "General").strip(),
                    (payload.get("notes") or "").strip(),
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM person_profiles WHERE id = ?", (profile_id,)).fetchone()

        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="PROFILE_CREATED",
            resource_type="person_profile",
            resource_id=profile_id,
            details=f"Created {category} profile {profile_code} (level={auth_level}, consent={consent_status})",
        )
        return dict(row)

    def update_profile(self, profile_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        settings = self.get_settings()
        with self.db.connection() as conn:
            existing = conn.execute("SELECT * FROM person_profiles WHERE id = ?", (profile_id,)).fetchone()
            if not existing:
                raise NotFoundError(f"Profile {profile_id} not found.")
            next_consent = payload.get("consent_status") if payload.get("consent_status") in ("granted", "pending", "revoked") else existing["consent_status"]
            next_auth = payload.get("authorization_level") if payload.get("authorization_level") in ("authorized", "visitor", "restricted", "anonymous") else existing["authorization_level"]

            if settings.get("require_consent_for_profiles") == "true" and next_auth == "authorized" and next_consent != "granted":
                raise PolicyViolationError("Consent must be granted before setting authorization level to authorized.")

            now = utc_now_iso()
            consent_recorded_at = existing["consent_recorded_at"] or now if next_consent == "granted" else existing["consent_recorded_at"]
            conn.execute(
                """
                UPDATE person_profiles
                SET display_name = ?, category = ?, authorization_level = ?, consent_status = ?, consent_recorded_at = ?, department_or_zone = ?, notes = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    (payload.get("display_name") or existing["display_name"]).strip(),
                    payload.get("category") if payload.get("category") in ("authorized", "anonymous") else existing["category"],
                    next_auth,
                    next_consent,
                    consent_recorded_at,
                    payload.get("department_or_zone", existing["department_or_zone"]).strip(),
                    payload.get("notes", existing["notes"]).strip(),
                    now,
                    profile_id,
                ),
            )
            updated = conn.execute("SELECT * FROM person_profiles WHERE id = ?", (profile_id,)).fetchone()

        result = dict(updated)
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="PROFILE_UPDATED",
            resource_type="person_profile",
            resource_id=profile_id,
            details=f"Updated profile {result['profile_code']} (consent={result['consent_status']}, level={result['authorization_level']})",
        )
        return result

    def delete_profile(self, profile_id: str) -> None:
        with self.db.connection() as conn:
            existing = conn.execute("SELECT profile_code FROM person_profiles WHERE id = ?", (profile_id,)).fetchone()
            if not existing:
                raise NotFoundError(f"Profile {profile_id} not found.")
            conn.execute("DELETE FROM person_profiles WHERE id = ?", (profile_id,))
        self.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="PROFILE_DELETED",
            resource_type="person_profile",
            resource_id=profile_id,
            details=f"Deleted person profile {existing['profile_code']}",
        )

    def list_audit_logs(self, limit: int = 100, outcome: str = "") -> list[dict[str, Any]]:
        capped = min(max(limit, 1), 500)
        with self.db.connection() as conn:
            if outcome:
                rows = conn.execute(
                    "SELECT * FROM audit_logs WHERE outcome = ? ORDER BY created_at DESC LIMIT ?",
                    (outcome, capped),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?",
                    (capped,),
                ).fetchall()
        return [dict(row) for row in rows]

    def get_dashboard_summary(self) -> dict[str, Any]:
        settings = self.get_settings()
        storage_dir = Path(settings.get("storage_directory", str(self.db.config.storage_dir)))
        thumb_dir = Path(settings.get("thumbnail_directory", str(self.db.config.thumbnail_dir)))
        quota_gb = float(settings.get("max_storage_quota_gb", "250") or "250")

        video_bytes = _dir_size_bytes(storage_dir)
        thumb_bytes = _dir_size_bytes(thumb_dir)
        db_bytes = self.db.config.db_path.stat().st_size if self.db.config.db_path.exists() else 0

        disk_free = None
        disk_total = None
        try:
            usage = shutil.disk_usage(self.db.config.storage_dir if self.db.config.storage_dir.exists() else Path("."))
            disk_free = usage.free
            disk_total = usage.total
        except OSError:
            pass

        with self.db.connection() as conn:
            total_videos = conn.execute("SELECT COUNT(*) AS c FROM video_files").fetchone()["c"]
            connected_cameras = conn.execute(
                "SELECT COUNT(*) AS c FROM cameras WHERE enabled = 1 AND status = 'online'"
            ).fetchone()["c"]
            total_cameras = conn.execute("SELECT COUNT(*) AS c FROM cameras").fetchone()["c"]
            active_streams = conn.execute(
                "SELECT COUNT(*) AS c FROM camera_stream_sessions WHERE status IN ('starting','streaming','reconnecting')"
            ).fetchone()["c"]
            active_recordings = conn.execute(
                "SELECT COUNT(*) AS c FROM recording_sessions WHERE status = 'recording'"
            ).fetchone()["c"]
            detected_events = conn.execute("SELECT COUNT(*) AS c FROM person_events").fetchone()["c"]
            anon_tracks = conn.execute(
                "SELECT COUNT(*) AS c FROM anonymous_tracks WHERE status != 'purged'"
            ).fetchone()["c"]
            anon_profiles = conn.execute(
                "SELECT COUNT(*) AS c FROM person_profiles WHERE category = 'anonymous'"
            ).fetchone()["c"]
            auth_profiles = conn.execute(
                "SELECT COUNT(*) AS c FROM person_profiles WHERE category = 'authorized'"
            ).fetchone()["c"]
            pending_reviews = conn.execute(
                "SELECT COUNT(*) AS c FROM watchlist_reviews WHERE status IN ('pending', 'in_review', 'escalated')"
            ).fetchone()["c"]

            status_rows = conn.execute(
                "SELECT processing_status, COUNT(*) AS c FROM video_files GROUP BY processing_status"
            ).fetchall()
            status_counts = {"imported": 0, "queued": 0, "inspecting": 0, "ready": 0, "failed": 0}
            for row in status_rows:
                if row["processing_status"] in status_counts:
                    status_counts[row["processing_status"]] = row["c"]

            recent_jobs = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT j.*, v.original_name AS video_name
                    FROM processing_jobs j
                    LEFT JOIN video_files v ON j.video_file_id = v.id
                    ORDER BY j.created_at DESC
                    LIMIT 10
                    """
                ).fetchall()
            ]
            recent_activity = [
                dict(r)
                for r in conn.execute("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 12").fetchall()
            ]

        return {
            "total_imported_videos": total_videos,
            "connected_cameras": connected_cameras,
            "total_cameras": total_cameras,
            "active_streams": active_streams,
            "active_recordings": active_recordings,
            "detected_person_events": detected_events,
            "anonymous_tracks_count": anon_tracks,
            "anonymous_person_profiles": anon_profiles,
            "authorized_registered_profiles": auth_profiles,
            "pending_security_reviews": pending_reviews,
            "storage_usage": {
                "storage_directory": str(storage_dir),
                "video_bytes_used": video_bytes,
                "thumbnail_bytes_used": thumb_bytes,
                "database_bytes_used": db_bytes,
                "total_app_bytes_used": video_bytes + thumb_bytes + db_bytes,
                "quota_bytes": int(quota_gb * 1024 * 1024 * 1024),
                "disk_free_bytes": disk_free,
                "disk_total_bytes": disk_total,
            },
            "recent_activity": recent_activity,
            "video_processing_status": {
                **status_counts,
                "recent_jobs": recent_jobs,
            },
            "system_capabilities": {
                "database_engine": settings.get("database_engine", "SQLite 3"),
                "ffmpeg_available": is_ffmpeg_available(),
                "opencv_available": get_opencv_status().available,
                "ai_stage": (
                    f"Stage 3 · OpenCV {get_opencv_status().version}"
                    if get_opencv_status().available
                    else "Stage 3 (OpenCV Pending)"
                ),
                "biometric_identification_enabled": BIOMETRIC_IDENTIFICATION_ENABLED,
                "runtime_mode": "python-fastapi",
            },
        }
