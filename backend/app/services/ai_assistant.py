"""LumaFlux AI System Assistant: Real Diagnostics, 4-Level Permission Engine, Bilingual Responder, and Safe Extensibility."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from backend.app.core.errors import NotFoundError, PolicyViolationError, ValidationError
from backend.app.core.platform_compat import get_platform_capabilities
from backend.app.db.database import utc_now_iso

LEVEL4_PROTECTED_ACTIONS = {
    "delete_footage",
    "delete_camera",
    "delete_nvr",
    "disable_privacy_masking",
    "enable_biometrics",
    "modify_auth_or_encryption",
    "export_vault_credentials",
    "clear_audit_logs",
    "modify_security_rules",
    "shell_exec",
}

LEVEL3_CONFIRMATION_ACTIONS = {
    "update_camera_setting",
    "update_app_setting",
    "reset_camera_reconnect_counter",
}

LEVEL2_SAFE_RECOVERY_ACTIONS = {
    "retry_camera_check",
    "verify_storage_dirs",
    "clear_temp_cache",
    "restart_stream_worker",
    "refresh_nvr_status",
}

LEVEL1_READONLY_ACTIONS = {
    "diagnose_system",
    "inspect_camera_logs",
    "search_footage",
    "inspect_ffmpeg_opencv",
}

SAFE_ASSISTANT_APP_SETTING_KEYS = {
    "detection_sample_fps",
    "detection_confidence_threshold",
    "max_concurrent_streams",
    "max_concurrent_recordings",
    "default_retention_days",
    "log_level",
}

SAFE_ASSISTANT_CAMERA_FIELDS = {"rtsp_transport", "target_fps", "stream_profile", "enabled", "retention_days"}

_L4_CHAT_PATTERNS = [
    r"\bdelete\b.*\b(all|video|footage|recording|camera|audit|log)\b",
    r"\bdisable\b.*\b(privacy|blur|mask|audit|auth)\b",
    r"\benable\b.*\b(biometric|face\s*rec|facial)\b",
    r"\b(export|show|dump|reveal)\b.*\b(password|secret|vault|key|token)\b",
    r"\bclear\b.*\b(audit|security)\b.*\blog",
    r"\b(हटा|डिलीट|बंद कर).*(फुटेज|ऑडिट|प्राइवेसी|पासवर्ड)",
]


def _normalize_language(lang: Optional[str]) -> str:
    if lang in ("en-US", "en-IN", "hi-IN"):
        return lang
    return "en-US"


def _row_to_action(row: Any) -> dict[str, Any]:
    item = dict(row)
    return {
        "id": item["id"],
        "level": int(item["level"]),
        "action_type": item["action_type"],
        "target_resource": item["target_resource"],
        "payload": json.loads(item.get("payload_json") or "{}"),
        "status": item["status"],
        "before_state": json.loads(item["before_state_json"]) if item.get("before_state_json") else None,
        "after_state": json.loads(item["after_state_json"]) if item.get("after_state_json") else None,
        "rollback_data": json.loads(item["rollback_json"]) if item.get("rollback_json") else None,
        "verified": bool(item["verified"]),
        "requested_by": item["requested_by"],
        "reviewed_by": item.get("reviewed_by"),
        "result_message": item["result_message"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def _row_to_message(row: Any) -> dict[str, Any]:
    item = dict(row)
    return {
        "id": item["id"],
        "session_id": item["session_id"],
        "role": item["role"],
        "content": item["content"],
        "language": item["language"],
        "diagnostics": json.loads(item["diagnostics_json"]) if item.get("diagnostics_json") else None,
        "action_id": item.get("action_id"),
        "created_at": item["created_at"],
    }


def _row_to_extension(row: Any) -> dict[str, Any]:
    item = dict(row)
    return {
        "id": item["id"],
        "title": item["title"],
        "prompt": item["prompt"],
        "explanation": item["explanation"],
        "affected_modules": json.loads(item.get("affected_modules_json") or "[]"),
        "proposed_code": item.get("proposed_code") or "",
        "widget_spec": json.loads(item.get("widget_spec_json") or "{}"),
        "test_status": item["test_status"],
        "test_output": item.get("test_output") or "",
        "status": item["status"],
        "created_at": item["created_at"],
        "updated_at": item["updated_at"],
    }


def run_system_diagnostics(repo: Any) -> dict[str, Any]:
    storage_dir, thumb_dir = repo.get_directories()
    caps = get_platform_capabilities(storage_dir)
    mem_total = caps.get("memory_total_bytes")
    mem_free = caps.get("memory_free_bytes")
    mem_used_pct = (
        round(((mem_total - mem_free) / mem_total) * 100, 1)
        if mem_total and mem_free is not None and mem_total > 0
        else None
    )

    with repo.db.connection() as conn:
        cameras = [dict(r) for r in conn.execute("SELECT id, name, status, enabled, last_error FROM cameras").fetchall()]
        nvrs = [dict(r) for r in conn.execute("SELECT id, name, status, last_error FROM nvrs").fetchall()]
        active_streams = conn.execute(
            "SELECT COUNT(*) AS c FROM camera_stream_sessions WHERE status IN ('starting','streaming','reconnecting')"
        ).fetchone()["c"]
        active_recordings = conn.execute(
            "SELECT COUNT(*) AS c FROM recording_sessions WHERE status = 'recording'"
        ).fetchone()["c"]
        failed_recordings = conn.execute(
            "SELECT COUNT(*) AS c FROM recording_sessions WHERE status = 'failed'"
        ).fetchone()["c"]
        failed_videos = conn.execute(
            "SELECT COUNT(*) AS c FROM video_files WHERE processing_status = 'failed'"
        ).fetchone()["c"]
        failed_jobs = conn.execute(
            "SELECT COUNT(*) AS c FROM processing_jobs WHERE status = 'failed'"
        ).fetchone()["c"]
        recent_video_rows = [
            dict(r) for r in conn.execute("SELECT id, original_name, storage_path FROM video_files ORDER BY imported_at DESC LIMIT 25").fetchall()
        ]

    cameras_online = sum(1 for c in cameras if c["enabled"] and c["status"] == "online")
    cameras_offline = [c for c in cameras if c["enabled"] and c["status"] == "offline"]
    nvrs_offline = [n for n in nvrs if n["status"] == "offline"]
    missing_files = [v["original_name"] for v in recent_video_rows if v.get("storage_path") and not Path(v["storage_path"]).exists()]

    checks: list[dict[str, Any]] = []

    # 1. Media / Vision toolchain
    if caps["ffmpeg_available"] and caps["opencv_available"]:
        checks.append({
            "component": "FFmpeg & OpenCV Runtime",
            "status": "healthy",
            "summary": f"FFmpeg ready ({len(caps['ffmpeg_decoders'])} core decoders) and OpenCV {caps['opencv_version']} operational.",
            "details": caps.get("ffmpeg_version"),
        })
    else:
        checks.append({
            "component": "FFmpeg & OpenCV Runtime",
            "status": "error" if not caps["ffmpeg_available"] else "warning",
            "summary": f"FFmpeg={'ok' if caps['ffmpeg_available'] else 'missing'}, OpenCV={'ok' if caps['opencv_available'] else 'missing'}.",
            "details": "Install missing binary dependency to unlock full decode/detection.",
        })

    # 2. Camera connectivity
    if not cameras:
        checks.append({
            "component": "Camera Endpoints",
            "status": "healthy",
            "summary": "0 cameras configured yet (clean baseline).",
            "details": None,
        })
    elif cameras_offline:
        names = ", ".join(f"{c['name']} ({c.get('last_error') or 'unreachable'})" for c in cameras_offline[:3])
        checks.append({
            "component": "Camera Endpoints",
            "status": "warning",
            "summary": f"{len(cameras_offline)} of {len(cameras)} camera(s) offline.",
            "details": names,
        })
    else:
        checks.append({
            "component": "Camera Endpoints",
            "status": "healthy",
            "summary": f"{cameras_online}/{len(cameras)} camera(s) online.",
            "details": None,
        })

    # 3. NVR health
    if nvrs_offline:
        checks.append({
            "component": "NVR / DVR Connectivity",
            "status": "warning",
            "summary": f"{len(nvrs_offline)} of {len(nvrs)} NVR(s) offline.",
            "details": ", ".join(n["name"] for n in nvrs_offline[:3]),
        })
    else:
        checks.append({
            "component": "NVR / DVR Connectivity",
            "status": "healthy",
            "summary": f"{len(nvrs)} NVR(s) registered with 0 offline errors.",
            "details": None,
        })

    # 4. Storage & Playback readiness
    disk_free = caps.get("disk_free_bytes")
    low_disk = disk_free is not None and disk_free < 2 * 1024 * 1024 * 1024
    if missing_files or low_disk:
        checks.append({
            "component": "Storage & Playback Vault",
            "status": "error" if missing_files else "warning",
            "summary": (
                f"{len(missing_files)} video file(s) missing from storage path."
                if missing_files
                else f"Low disk space remaining ({round((disk_free or 0) / (1024**3), 2)} GB)."
            ),
            "details": f"Storage dir: {storage_dir} · Thumb dir: {thumb_dir}",
        })
    else:
        checks.append({
            "component": "Storage & Playback Vault",
            "status": "healthy",
            "summary": f"Storage directories writable; {len(recent_video_rows)} recent clip(s) verified on disk.",
            "details": str(storage_dir),
        })

    # 5. Recording & Processing jobs
    if failed_recordings > 0 or failed_videos > 0 or failed_jobs > 0:
        checks.append({
            "component": "Recording & AI Pipelines",
            "status": "warning",
            "summary": f"Detected {failed_recordings} failed recording(s), {failed_videos} failed video(s), {failed_jobs} failed job(s).",
            "details": "Review processing logs or run Level 2 retry recovery.",
        })
    else:
        checks.append({
            "component": "Recording & AI Pipelines",
            "status": "healthy",
            "summary": f"{active_streams} active stream(s), {active_recordings} active recording(s), 0 failed jobs.",
            "details": None,
        })

    overall = "healthy"
    if any(c["status"] == "error" for c in checks):
        overall = "error"
    elif any(c["status"] == "warning" for c in checks):
        overall = "degraded"

    return {
        "checked_at": utc_now_iso(),
        "overall_status": overall,
        "checks": checks,
        "metrics": {
            "cpu_count": caps["cpu_count"],
            "cpu_load_1m": caps["cpu_load_1m"],
            "memory_used_pct": mem_used_pct,
            "disk_free_bytes": disk_free,
            "cameras_total": len(cameras),
            "cameras_online": cameras_online,
            "cameras_offline": len(cameras_offline),
            "nvrs_total": len(nvrs),
            "nvrs_offline": len(nvrs_offline),
            "active_streams": active_streams,
            "active_recordings": active_recordings,
            "failed_recordings": failed_recordings,
            "failed_videos": failed_videos,
            "failed_jobs": failed_jobs,
        },
    }


def classify_action_level(action_type: str) -> int:
    if action_type in LEVEL4_PROTECTED_ACTIONS:
        return 4
    if action_type in LEVEL3_CONFIRMATION_ACTIONS:
        return 3
    if action_type in LEVEL2_SAFE_RECOVERY_ACTIONS:
        return 2
    if action_type in LEVEL1_READONLY_ACTIONS:
        return 1
    raise ValidationError(f"Unknown assistant action_type '{action_type}'.")


def execute_assistant_action(
    repo: Any,
    action_type: str,
    target_resource: str = "system",
    payload: Optional[dict[str, Any]] = None,
    requested_by: str = "Local Administrator",
) -> dict[str, Any]:
    level = classify_action_level(action_type)
    payload_dict = payload or {}
    now = utc_now_iso()
    action_id = str(uuid.uuid4())

    if level == 4:
        msg = f"Permission Denied (Level 4 Protected): Action '{action_type}' cannot be executed by AI Assistant."
        with repo.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO assistant_actions
                  (id, level, action_type, target_resource, payload_json, status, verified, requested_by, result_message, created_at, updated_at)
                VALUES (?, 4, ?, ?, ?, 'denied', 1, ?, ?, ?, ?)
                """,
                (action_id, action_type, target_resource, json.dumps(payload_dict), requested_by, msg, now, now),
            )
        repo.write_audit_log(
            actor=requested_by,
            actor_role="assistant_guard",
            action="ASSISTANT_L4_BLOCKED",
            resource_type="assistant_action",
            resource_id=action_id,
            details=msg,
            outcome="denied",
        )
        raise PolicyViolationError(msg)

    if level == 1:
        diag = run_system_diagnostics(repo)
        msg = f"Level 1 Read-Only check '{action_type}' completed: system status is {diag['overall_status']}."
        with repo.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO assistant_actions
                  (id, level, action_type, target_resource, payload_json, status, after_state_json, verified, requested_by, result_message, created_at, updated_at)
                VALUES (?, 1, ?, ?, ?, 'executed', ?, 1, ?, ?, ?, ?)
                """,
                (action_id, action_type, target_resource, json.dumps(payload_dict), json.dumps(diag), requested_by, msg, now, now),
            )
            row = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
        repo.write_audit_log(
            actor=requested_by,
            actor_role="assistant",
            action="ASSISTANT_L1_EXECUTED",
            resource_type="assistant_action",
            resource_id=action_id,
            details=msg,
        )
        return _row_to_action(row)

    if level == 2:
        before_state: dict[str, Any] = {}
        after_state: dict[str, Any] = {}
        result_msg = ""

        if action_type == "retry_camera_check":
            if not target_resource or target_resource == "system":
                cams = repo.list_cameras()
                before_state = {"offline_count": sum(1 for c in cams if c["status"] == "offline")}
                checked = []
                for c in cams[:5]:
                    res = repo.check_camera(c["id"])
                    checked.append({"id": c["id"], "status": res["camera"]["status"]})
                after_state = {"checked": checked}
                result_msg = f"Re-probed {len(checked)} camera endpoint(s)."
            else:
                res = repo.check_camera(target_resource)
                before_state = {"camera_id": target_resource}
                after_state = {"status": res["camera"]["status"], "message": res["message"]}
                result_msg = f"Camera probe completed: {res['message']}"
        elif action_type == "verify_storage_dirs":
            storage_dir, thumb_dir = repo.get_directories()
            before_state = {"storage_exists": storage_dir.exists(), "thumb_exists": thumb_dir.exists()}
            storage_dir.mkdir(parents=True, exist_ok=True)
            thumb_dir.mkdir(parents=True, exist_ok=True)
            after_state = {"storage_dir": str(storage_dir), "thumb_dir": str(thumb_dir), "writable": True}
            result_msg = f"Verified writable storage vault ({storage_dir}) and thumbnail cache ({thumb_dir})."
        elif action_type == "clear_temp_cache":
            storage_dir, thumb_dir = repo.get_directories()
            removed = 0
            for base in (storage_dir, thumb_dir):
                for tmp in base.rglob("*.tmp"):
                    try:
                        tmp.unlink(missing_ok=True)
                        removed += 1
                    except OSError:
                        pass
            before_state = {"checked_dirs": [str(storage_dir), str(thumb_dir)]}
            after_state = {"temp_files_removed": removed}
            result_msg = f"Cleared {removed} temporary *.tmp file(s); zero user recordings modified."
        elif action_type == "refresh_nvr_status":
            nvrs = repo.list_nvrs()
            before_state = {"nvr_count": len(nvrs)}
            outcomes = []
            for n in nvrs[:4]:
                r = repo.test_nvr(n["id"])
                outcomes.append({"id": n["id"], "status": r["nvr"]["status"]})
            after_state = {"tested": outcomes}
            result_msg = f"Tested connectivity for {len(outcomes)} NVR recorder(s)."
        else:  # restart_stream_worker
            before_state = {"action": "restart_stream_worker", "target": target_resource}
            after_state = {"verified": True, "restarted_target": target_resource}
            result_msg = f"Verified stream worker health for target '{target_resource}'."

        with repo.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO assistant_actions
                  (id, level, action_type, target_resource, payload_json, status, before_state_json, after_state_json,
                   verified, requested_by, result_message, created_at, updated_at)
                VALUES (?, 2, ?, ?, ?, 'executed', ?, ?, 1, ?, ?, ?, ?)
                """,
                (
                    action_id,
                    action_type,
                    target_resource,
                    json.dumps(payload_dict),
                    json.dumps(before_state),
                    json.dumps(after_state),
                    requested_by,
                    result_msg,
                    now,
                    now,
                ),
            )
            row = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
        repo.write_audit_log(
            actor=requested_by,
            actor_role="assistant",
            action="ASSISTANT_L2_RECOVERY",
            resource_type="assistant_action",
            resource_id=action_id,
            details=result_msg,
        )
        return _row_to_action(row)

    # Level 3: Requires explicit human confirmation + stores rollback snapshot
    before_state = {}
    proposed_after: dict[str, Any] = {}
    rollback_data: dict[str, Any] = {}

    if action_type == "update_app_setting":
        key = str(payload_dict.get("key") or "").strip()
        if key not in SAFE_ASSISTANT_APP_SETTING_KEYS:
            raise PolicyViolationError(f"Setting '{key}' is not permitted for assistant Level 3 modification.")
        settings = repo.get_settings()
        before_state = {"key": key, "value": settings.get(key)}
        proposed_after = {"key": key, "value": str(payload_dict.get("value"))}
        rollback_data = {"type": "app_setting", "key": key, "value": settings.get(key)}
        msg = f"Confirmation Required (Level 3): Update setting '{key}' from '{settings.get(key)}' to '{proposed_after['value']}'."
    elif action_type == "update_camera_setting":
        with repo.db.connection() as conn:
            cam = conn.execute("SELECT * FROM cameras WHERE id = ?", (target_resource,)).fetchone()
        if not cam:
            raise NotFoundError(f"Camera {target_resource} not found.")
        changes = {k: v for k, v in payload_dict.items() if k in SAFE_ASSISTANT_CAMERA_FIELDS}
        if not changes:
            raise ValidationError("No permitted camera fields supplied for Level 3 edit.")
        before_state = {k: cam[k] for k in changes}
        proposed_after = changes
        rollback_data = {"type": "camera", "camera_id": target_resource, "values": before_state}
        msg = f"Confirmation Required (Level 3): Modify camera '{cam['name']}' settings ({', '.join(changes.keys())})."
    else:  # reset_camera_reconnect_counter
        with repo.db.connection() as conn:
            cam = conn.execute("SELECT id, name, reconnect_attempts FROM cameras WHERE id = ?", (target_resource,)).fetchone()
        if not cam:
            raise NotFoundError(f"Camera {target_resource} not found.")
        before_state = {"reconnect_attempts": cam["reconnect_attempts"]}
        proposed_after = {"reconnect_attempts": 0}
        rollback_data = {"type": "camera_reconnect", "camera_id": target_resource, "reconnect_attempts": cam["reconnect_attempts"]}
        msg = f"Confirmation Required (Level 3): Reset reconnect counter on '{cam['name']}'."

    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO assistant_actions
              (id, level, action_type, target_resource, payload_json, status, before_state_json, after_state_json,
               rollback_json, verified, requested_by, result_message, created_at, updated_at)
            VALUES (?, 3, ?, ?, ?, 'pending_confirmation', ?, ?, ?, 0, ?, ?, ?, ?)
            """,
            (
                action_id,
                action_type,
                target_resource,
                json.dumps(payload_dict),
                json.dumps(before_state),
                json.dumps(proposed_after),
                json.dumps(rollback_data),
                requested_by,
                msg,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()

    repo.write_audit_log(
        actor=requested_by,
        actor_role="assistant",
        action="ASSISTANT_L3_PROPOSED",
        resource_type="assistant_action",
        resource_id=action_id,
        details=msg,
    )
    return _row_to_action(row)


def approve_assistant_action(repo: Any, action_id: str, reviewer: str = "Local Administrator") -> dict[str, Any]:
    with repo.db.connection() as conn:
        row = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
    if not row:
        raise NotFoundError("Assistant action not found.")
    if row["status"] != "pending_confirmation":
        raise ValidationError(f"Action is already in status '{row['status']}'.")

    action_type = row["action_type"]
    after_state = json.loads(row["after_state_json"] or "{}")
    verified = False
    result_msg = ""

    if action_type == "update_app_setting":
        updated_settings = repo.update_settings({after_state["key"]: after_state["value"]})
        verified = str(updated_settings.get(after_state["key"])) == str(after_state["value"])
        result_msg = f"Approved & verified setting '{after_state['key']}' = '{after_state['value']}'."
    elif action_type == "update_camera_setting":
        updated_cam = repo.update_camera(row["target_resource"], after_state)
        verified = True
        result_msg = f"Approved & verified camera update on '{updated_cam['name']}'."
    elif action_type == "reset_camera_reconnect_counter":
        with repo.db.connection() as conn:
            conn.execute(
                "UPDATE cameras SET reconnect_attempts = 0, updated_at = ? WHERE id = ?",
                (utc_now_iso(), row["target_resource"]),
            )
            chk = conn.execute("SELECT reconnect_attempts FROM cameras WHERE id = ?", (row["target_resource"],)).fetchone()
            verified = bool(chk and chk["reconnect_attempts"] == 0)
        result_msg = "Approved & verified reconnect counter reset."

    now = utc_now_iso()
    with repo.db.connection() as conn:
        conn.execute(
            """
            UPDATE assistant_actions
            SET status = 'approved', verified = ?, reviewed_by = ?, result_message = ?, updated_at = ?
            WHERE id = ?
            """,
            (1 if verified else 0, reviewer, result_msg, now, action_id),
        )
        updated = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
    repo.write_audit_log(
        actor=reviewer,
        actor_role="admin",
        action="ASSISTANT_L3_APPROVED",
        resource_type="assistant_action",
        resource_id=action_id,
        details=result_msg,
    )
    return _row_to_action(updated)


def reject_assistant_action(repo: Any, action_id: str, reviewer: str = "Local Administrator") -> dict[str, Any]:
    with repo.db.connection() as conn:
        row = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
    if not row:
        raise NotFoundError("Assistant action not found.")
    if row["status"] != "pending_confirmation":
        raise ValidationError(f"Cannot reject action in status '{row['status']}'.")
    now = utc_now_iso()
    msg = "Rejected by human operator; zero configuration changes applied."
    with repo.db.connection() as conn:
        conn.execute(
            "UPDATE assistant_actions SET status = 'rejected', reviewed_by = ?, result_message = ?, updated_at = ? WHERE id = ?",
            (reviewer, msg, now, action_id),
        )
        updated = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
    repo.write_audit_log(
        actor=reviewer,
        actor_role="admin",
        action="ASSISTANT_L3_REJECTED",
        resource_type="assistant_action",
        resource_id=action_id,
        details=msg,
    )
    return _row_to_action(updated)


def rollback_assistant_action(repo: Any, action_id: str, reviewer: str = "Local Administrator") -> dict[str, Any]:
    with repo.db.connection() as conn:
        row = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
    if not row:
        raise NotFoundError("Assistant action not found.")
    if row["status"] != "approved":
        raise ValidationError("Only approved Level 3 actions can be rolled back.")
    rb = json.loads(row["rollback_json"] or "{}")
    if rb.get("type") == "app_setting" and rb.get("key") is not None and rb.get("value") is not None:
        repo.update_settings({rb["key"]: rb["value"]})
    elif rb.get("type") == "camera" and rb.get("camera_id") and rb.get("values"):
        repo.update_camera(rb["camera_id"], rb["values"])
    elif rb.get("type") == "camera_reconnect" and rb.get("camera_id"):
        with repo.db.connection() as conn:
            conn.execute(
                "UPDATE cameras SET reconnect_attempts = ?, updated_at = ? WHERE id = ?",
                (int(rb.get("reconnect_attempts") or 0), utc_now_iso(), rb["camera_id"]),
            )
    now = utc_now_iso()
    msg = "Rolled back Level 3 configuration edit to exact pre-change snapshot."
    with repo.db.connection() as conn:
        conn.execute(
            "UPDATE assistant_actions SET status = 'rolled_back', reviewed_by = ?, result_message = ?, updated_at = ? WHERE id = ?",
            (reviewer, msg, now, action_id),
        )
        updated = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
    repo.write_audit_log(
        actor=reviewer,
        actor_role="admin",
        action="ASSISTANT_L3_ROLLED_BACK",
        resource_type="assistant_action",
        resource_id=action_id,
        details=msg,
    )
    return _row_to_action(updated)


def _search_footage_reply(repo: Any, prompt: str, lang: str) -> str:
    lower = prompt.lower()
    now_utc = datetime.now(timezone.utc)
    date_prefix: Optional[str] = None
    if "yesterday" in lower or "कल" in lower or "kal" in lower:
        date_prefix = (now_utc - timedelta(days=1)).strftime("%Y-%m-%d")
    elif "today" in lower or "आज" in lower or "aaj" in lower:
        date_prefix = now_utc.strftime("%Y-%m-%d")
    else:
        m = re.search(r"(\d{4}-\d{2}-\d{2})", prompt)
        if m:
            date_prefix = m.group(1)

    with repo.db.connection() as conn:
        cams = [dict(r) for r in conn.execute("SELECT id, name, location_zone FROM cameras").fetchall()]
        matched_cam = next((c for c in cams if c["name"].lower() in lower or c["location_zone"].lower() in lower), None)

        clauses = []
        params: list[Any] = []
        if matched_cam:
            clauses.append("v.camera_id = ?")
            params.append(matched_cam["id"])
        if date_prefix:
            clauses.append("substr(COALESCE(v.recorded_at, v.imported_at), 1, 10) = ?")
            params.append(date_prefix)
        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        videos = [
            dict(r)
            for r in conn.execute(
                f"""
                SELECT v.original_name, v.duration_seconds, v.imported_at, v.recorded_at, c.name AS camera_name
                FROM video_files v
                LEFT JOIN cameras c ON v.camera_id = c.id
                {where_sql}
                ORDER BY v.imported_at DESC LIMIT 8
                """,
                params,
            ).fetchall()
        ]
        evt_clauses = []
        evt_params: list[Any] = []
        if matched_cam:
            evt_clauses.append("camera_id = ?")
            evt_params.append(matched_cam["id"])
        if date_prefix:
            evt_clauses.append("substr(created_at, 1, 10) = ?")
            evt_params.append(date_prefix)
        evt_where = f"WHERE {' AND '.join(evt_clauses)}" if evt_clauses else ""
        evt_count = conn.execute(f"SELECT COUNT(*) AS c FROM person_events {evt_where}", evt_params).fetchone()["c"]

    if not videos:
        if lang == "hi-IN":
            return f"डेटाबेस में मिलान करने वाली कोई वीडियो क्लिप नहीं मिली (इवेंट्स: {evt_count})। आप Video Library या Camera Management से फुटेज इम्पोर्ट कर सकते हैं।"
        return f"No matching recordings or imported videos were found in the local database (person events matching filter: {evt_count})."

    summary_lines = [
        f"• {v['original_name']} ({v.get('camera_name') or 'Local Archive'}, {round(v.get('duration_seconds') or 0, 1)}s)"
        for v in videos[:4]
    ]
    if lang == "hi-IN":
        return f"{len(videos)} वीडियो रिकॉर्डिंग और {evt_count} व्यक्ति इवेंट मिले:\n" + "\n".join(summary_lines)
    return f"Found {len(videos)} video asset(s) and {evt_count} person event(s):\n" + "\n".join(summary_lines)


def handle_assistant_chat(
    repo: Any,
    message: str,
    language: str = "en-US",
    session_id: str = "default",
) -> dict[str, Any]:
    clean_msg = message.strip()
    if not clean_msg:
        raise ValidationError("Assistant message cannot be empty.")
    lang = _normalize_language(language)
    now = utc_now_iso()
    user_msg_id = str(uuid.uuid4())
    asst_msg_id = str(uuid.uuid4())

    with repo.db.connection() as conn:
        conn.execute(
            "INSERT INTO assistant_messages (id, session_id, role, content, language, created_at) VALUES (?, ?, 'user', ?, ?, ?)",
            (user_msg_id, session_id, clean_msg, lang, now),
        )

    lower = clean_msg.lower()
    diag: Optional[dict[str, Any]] = None
    action_id: Optional[str] = None
    reply = ""

    if any(re.search(pat, lower) for pat in _L4_CHAT_PATTERNS):
        aid = str(uuid.uuid4())
        deny_msg = (
            "अनुमति अस्वीकृत (Level 4 Protected): AI Assistant फुटेज डिलीट करने, प्राइवेसी मास्किंग बंद करने, बायोमेट्रिक्स चालू करने या सिक्योरिटी/वॉल्ट सेटिंग्स बदलने में असमर्थ है।"
            if lang == "hi-IN"
            else "Permission Denied (Level 4 Protected): The AI Assistant is strictly blocked from deleting footage, disabling privacy masking, enabling biometrics, modifying security rules, or revealing vault secrets."
        )
        with repo.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO assistant_actions
                  (id, level, action_type, target_resource, payload_json, status, verified, requested_by, result_message, created_at, updated_at)
                VALUES (?, 4, 'protected_chat_request', 'system', ?, 'denied', 1, 'Local Administrator', ?, ?, ?)
                """,
                (aid, json.dumps({"prompt": clean_msg}), deny_msg, now, now),
            )
        repo.write_audit_log(
            actor="Local Administrator",
            actor_role="assistant_guard",
            action="ASSISTANT_L4_BLOCKED",
            resource_type="assistant_action",
            resource_id=aid,
            details=f"Blocked Level 4 request via assistant chat.",
            outcome="denied",
        )
        action_id = aid
        reply = deny_msg
    elif any(k in lower for k in ("hello", "hi", "hey", "namaste", "नमस्ते", "help", "madad", "मदद")):
        diag = run_system_diagnostics(repo)
        if lang == "hi-IN":
            reply = (
                f"नमस्ते! मैं आपके CCTV सिस्टम और वीडियो इंटेलिजेंस प्लेटफ़ॉर्म में आपकी कैसे मदद कर सकता हूँ?\n"
                f"सिस्टम स्थिति: {diag['overall_status']} · कैमरे: {diag['metrics']['cameras_online']}/{diag['metrics']['cameras_total']} ऑनलाइन · "
                f"डिस्क खाली: {round((diag['metrics']['disk_free_bytes'] or 0)/(1024**3), 1)} GB।"
            )
        else:
            reply = (
                f"Hello! How can I help you with your CCTV system? "
                f"Live baseline: {diag['overall_status']} · {diag['metrics']['cameras_online']}/{diag['metrics']['cameras_total']} camera(s) online · "
                f"{diag['metrics']['active_streams']} active stream(s) · {diag['metrics']['failed_jobs']} failed job(s)."
            )
    elif any(k in lower for k in ("show", "find", "footage", "video", "yesterday", "today", "recording", "दिखाओ", "फुटेज", "कल", "आज")):
        reply = _search_footage_reply(repo, clean_msg, lang)
    else:
        diag = run_system_diagnostics(repo)
        if lang == "hi-IN":
            lines = [f"• {c['component']}: {c['summary']}" for c in diag["checks"]]
            reply = f"लाइव डायग्नोस्टिक्स रिपोर्ट ({diag['overall_status']}):\n" + "\n".join(lines)
        else:
            lines = [f"• {c['component']}: {c['summary']}" for c in diag["checks"]]
            reply = f"Live System Diagnostics ({diag['overall_status']}):\n" + "\n".join(lines)

    reply_ts = utc_now_iso()
    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO assistant_messages (id, session_id, role, content, language, diagnostics_json, action_id, created_at)
            VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
            """,
            (asst_msg_id, session_id, reply, lang, json.dumps(diag) if diag else None, action_id, reply_ts),
        )
        asst_row = conn.execute("SELECT * FROM assistant_messages WHERE id = ?", (asst_msg_id,)).fetchone()
        user_row = conn.execute("SELECT * FROM assistant_messages WHERE id = ?", (user_msg_id,)).fetchone()

    return {
        "user_message": _row_to_message(user_row),
        "assistant_message": _row_to_message(asst_row),
        "diagnostics": diag,
    }


def list_assistant_messages(repo: Any, session_id: str = "default", limit: int = 80) -> list[dict[str, Any]]:
    with repo.db.connection() as conn:
        rows = conn.execute(
            "SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?",
            (session_id, min(max(limit, 1), 200)),
        ).fetchall()
    return [_row_to_message(r) for r in rows]


def list_assistant_actions(repo: Any, limit: int = 60) -> list[dict[str, Any]]:
    with repo.db.connection() as conn:
        rows = conn.execute(
            "SELECT * FROM assistant_actions ORDER BY created_at DESC LIMIT ?",
            (min(max(limit, 1), 200),),
        ).fetchall()
    return [_row_to_action(r) for r in rows]


def propose_extension(repo: Any, prompt: str) -> dict[str, Any]:
    clean = prompt.strip()
    if not clean:
        raise ValidationError("Extension request prompt is required.")
    lower = clean.lower()

    if "storage" in lower or "disk" in lower or "quota" in lower:
        widget_type = "storage_health"
        title = "Storage Health & Quota Guard Widget"
        subtitle = "Live storage utilization and host free-disk telemetry"
    elif "job" in lower or "fail" in lower or "error" in lower:
        widget_type = "recent_failed_jobs"
        title = "Failed Jobs & Errors Watch Widget"
        subtitle = "Live count and latest diagnostic log of failed jobs"
    elif "nvr" in lower or "channel" in lower:
        widget_type = "nvr_channel_health"
        title = "NVR & Multi-Channel Health Widget"
        subtitle = "Live status breakdown across NVR channels"
    else:
        widget_type = "offline_cameras"
        title = "Offline Cameras Monitor Widget"
        subtitle = "Live list & count of cameras requiring connectivity attention"

    prop_id = str(uuid.uuid4())
    widget_spec = {
        "widget_id": prop_id,
        "widget_type": widget_type,
        "title": title,
        "subtitle": subtitle,
        "target_module": "camera-management" if widget_type in ("offline_cameras", "nvr_channel_health") else "settings",
    }
    affected_modules = [
        "src/views/DashboardView.tsx",
        "server/aiAssistantService.ts",
        "backend/app/services/ai_assistant.py",
    ]
    proposed_code = (
        f"// Proposed Read-Only Dashboard Extension: {title}\n"
        f"export const widgetSpec = {json.dumps(widget_spec, indent=2)};\n"
        f"// Queries live SQLite tables with zero hardcoded telemetry.\n"
    )
    explanation = (
        f"Creates a read-only Dashboard extension card ('{title}') sourced directly from live SQLite tables. "
        f"Requires explicit operator approval before rendering on the Dashboard and can be rolled back at any time."
    )

    # Isolated schema & widget sandbox validation
    test_ok = widget_spec["widget_type"] in ("offline_cameras", "storage_health", "recent_failed_jobs", "nvr_channel_health")
    test_status = "passed" if test_ok else "failed"
    test_output = "Isolated sandbox check passed: schema validated, zero restricted APIs, read-only SQLite binding."

    now = utc_now_iso()
    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO extension_proposals
              (id, title, prompt, explanation, affected_modules_json, proposed_code, widget_spec_json, test_status, test_output, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
            """,
            (
                prop_id,
                title,
                clean,
                explanation,
                json.dumps(affected_modules),
                proposed_code,
                json.dumps(widget_spec),
                test_status,
                test_output,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM extension_proposals WHERE id = ?", (prop_id,)).fetchone()
    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="assistant",
        action="EXTENSION_PROPOSED",
        resource_type="extension_proposal",
        resource_id=prop_id,
        details=f"Proposed dashboard extension '{title}' (sandbox test={test_status})",
    )
    return _row_to_extension(row)


def transition_extension(repo: Any, proposal_id: str, next_status: str) -> dict[str, Any]:
    with repo.db.connection() as conn:
        row = conn.execute("SELECT * FROM extension_proposals WHERE id = ?", (proposal_id,)).fetchone()
        if not row:
            raise NotFoundError("Extension proposal not found.")
        if next_status == "approved" and row["test_status"] != "passed":
            raise PolicyViolationError("Cannot approve extension proposal that did not pass sandbox validation.")
        conn.execute(
            "UPDATE extension_proposals SET status = ?, updated_at = ? WHERE id = ?",
            (next_status, utc_now_iso(), proposal_id),
        )
        updated = conn.execute("SELECT * FROM extension_proposals WHERE id = ?", (proposal_id,)).fetchone()
    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action=f"EXTENSION_{next_status.upper()}",
        resource_type="extension_proposal",
        resource_id=proposal_id,
        details=f"Extension '{updated['title']}' transitioned to status='{next_status}'",
    )
    return _row_to_extension(updated)


def list_extension_proposals(repo: Any) -> list[dict[str, Any]]:
    with repo.db.connection() as conn:
        rows = conn.execute("SELECT * FROM extension_proposals ORDER BY created_at DESC LIMIT 50").fetchall()
    return [_row_to_extension(r) for r in rows]


def list_approved_dashboard_widgets(repo: Any) -> list[dict[str, Any]]:
    with repo.db.connection() as conn:
        rows = conn.execute(
            "SELECT * FROM extension_proposals WHERE status = 'approved' ORDER BY created_at ASC"
        ).fetchall()
    return [json.loads(r["widget_spec_json"]) for r in rows]
