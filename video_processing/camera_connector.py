"""Stage 3: Real CCTV/IP camera connectivity probing, ONVIF 6-stage verification, MP4 decode checks, and local source discovery."""

from __future__ import annotations

import json
import re
import socket
import subprocess
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from backend.app.core.credentials import inject_uri_credentials, sanitize_secret_text, strip_uri_credentials
from video_processing.ffmpeg_probe import is_ffmpeg_available, is_ffprobe_available, probe_video_file
from video_processing.onvif_client import VerificationStages, verify_onvif_and_rtsp

ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".ts"}
_QUERY_SECRET_RE = re.compile(r"((?:password|passwd|pwd|pass|token|secret)=)([^&\s]+)", re.IGNORECASE)
_INLINE_CRED_RE = re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://[^:/\s@]+:)([^@\s/]+)(@)")


@dataclass
class CameraProbeResult:
    reachable: bool
    status: str  # 'online' | 'offline'
    message: str
    error: Optional[str] = None
    codec: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    discovered_files: int = 0
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware_version: Optional[str] = None
    main_stream_uri: Optional[str] = None
    sub_stream_uri: Optional[str] = None
    stages: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def redact_stream_uri(uri: str) -> str:
    """Mask embedded passwords in RTSP/HTTP/ONVIF URIs before display or logging."""
    raw = (uri or "").strip()
    if not raw:
        return ""
    masked = _INLINE_CRED_RE.sub(r"\1****\3", raw)
    masked = _QUERY_SECRET_RE.sub(r"\1****", masked)
    return masked


def sanitize_log_text(text: str, raw_uri: Optional[str] = None, extra_secret: Optional[str] = None) -> str:
    """Remove any embedded credentials or explicit secret values from error strings/logs."""
    cleaned = text or ""
    if raw_uri:
        redacted = redact_stream_uri(raw_uri)
        if raw_uri in cleaned:
            cleaned = cleaned.replace(raw_uri, redacted)
        try:
            parsed = urlparse(raw_uri)
            if parsed.password:
                cleaned = sanitize_secret_text(cleaned, parsed.password)
        except ValueError:
            pass
    return sanitize_secret_text(cleaned, extra_secret)


def _tcp_check(host: str, port: int, timeout_sec: float = 2.5) -> tuple[bool, Optional[str]]:
    try:
        with socket.create_connection((host, port), timeout=timeout_sec):
            return True, None
    except OSError as exc:
        return False, f"TCP connection failed to {host}:{port} ({exc})"


def ffprobe_stream(
    uri: str,
    rtsp_transport: Optional[str] = None,
    timeout_sec: float = 6.0,
) -> tuple[bool, dict[str, Any], Optional[str]]:
    if not is_ffprobe_available():
        return False, {}, "ffprobe binary is unavailable on host PATH."
    cmd = ["ffprobe", "-v", "error"]
    if rtsp_transport in ("tcp", "udp"):
        cmd.extend(["-rtsp_transport", rtsp_transport])
    cmd.extend(["-show_streams", "-show_format", "-of", "json", uri])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec, check=False)
    except subprocess.TimeoutExpired:
        return False, {}, f"Stream probe timed out after {timeout_sec:.0f}s."
    except OSError as exc:
        return False, {}, sanitize_log_text(str(exc), uri)

    if proc.returncode != 0:
        err_msg = sanitize_log_text((proc.stderr or "").strip() or f"ffprobe exited with code {proc.returncode}", uri)
        return False, {}, err_msg

    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return False, {}, "Malformed metadata returned by ffprobe."

    video_stream = next((s for s in payload.get("streams", []) if s.get("codec_type") == "video"), None)
    if not video_stream:
        return False, {}, "Connected to endpoint, but no active video stream track was detected."

    fps: Optional[float] = None
    rate = video_stream.get("r_frame_rate") or ""
    if "/" in rate:
        num_s, den_s = rate.split("/", 1)
        try:
            den = float(den_s)
            if den > 0:
                fps = round(float(num_s) / den, 2)
        except ValueError:
            fps = None

    return (
        True,
        {
            "codec": video_stream.get("codec_name"),
            "width": int(video_stream["width"]) if video_stream.get("width") else None,
            "height": int(video_stream["height"]) if video_stream.get("height") else None,
            "fps": fps,
        },
        None,
    )


def verify_mp4_integrity(file_path: Path, timeout_sec: float = 8.0) -> tuple[bool, dict[str, Any], Optional[str]]:
    """Verify recorded MP4 has valid metadata AND decodes frames without container errors."""
    target = Path(file_path)
    if not target.exists() or target.stat().st_size == 0:
        return False, {}, "Recorded file missing or empty (0 bytes)."

    meta = probe_video_file(target)
    if not meta.codec and not meta.width:
        return False, meta.to_dict(), "Recorded MP4 contains no valid video stream."

    if is_ffmpeg_available():
        try:
            proc = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", str(target), "-t", "2", "-f", "null", "-"],
                capture_output=True,
                text=True,
                timeout=timeout_sec,
                check=False,
            )
            if proc.returncode != 0:
                err = (proc.stderr or "").strip() or f"FFmpeg decode check failed (exit {proc.returncode})"
                return False, meta.to_dict(), err
        except subprocess.TimeoutExpired:
            return False, meta.to_dict(), "FFmpeg decode integrity check timed out."
        except OSError as exc:
            return False, meta.to_dict(), str(exc)

    return True, meta.to_dict(), None


def discover_local_videos(path_str: str) -> list[Path]:
    """Return sorted local CCTV video files from a file or directory path."""
    target = Path(path_str).expanduser()
    if not target.exists():
        return []
    if target.is_file():
        return [target] if target.suffix.lower() in ALLOWED_VIDEO_EXTENSIONS else []
    if target.is_dir():
        return sorted(
            item
            for item in target.iterdir()
            if item.is_file() and item.suffix.lower() in ALLOWED_VIDEO_EXTENSIONS
        )
    return []


def build_effective_camera_uri(
    source_type: str,
    stream_uri: str,
    main_stream_uri: Optional[str] = None,
    sub_stream_uri: Optional[str] = None,
    stream_profile: str = "main",
    username: Optional[str] = None,
    password: Optional[str] = None,
) -> str:
    """Resolve effective target URI (Main vs Sub profile) and inject credentials strictly in memory."""
    candidate = (stream_uri or "").strip()
    if source_type in ("rtsp", "onvif", "http"):
        if stream_profile == "sub" and sub_stream_uri:
            candidate = sub_stream_uri.strip()
        elif main_stream_uri and (source_type != "onvif" or main_stream_uri.lower().startswith("rtsp")):
            candidate = main_stream_uri.strip()
    if source_type == "local_archive":
        return candidate
    return inject_uri_credentials(candidate, username, password)


def probe_camera_endpoint(
    source_type: str,
    stream_uri: str,
    timeout_sec: float = 6.0,
    rtsp_transport: str = "tcp",
    username: Optional[str] = None,
    password: Optional[str] = None,
    stream_profile: str = "main",
    main_stream_uri: Optional[str] = None,
    sub_stream_uri: Optional[str] = None,
) -> CameraProbeResult:
    """Perform genuine connectivity & stream verification without fabricating online status."""
    raw = (stream_uri or "").strip()
    if not raw:
        return CameraProbeResult(False, "offline", "Stream URI or local path is empty.", error="EMPTY_URI")

    transport = "udp" if str(rtsp_transport).lower() == "udp" else "tcp"

    if source_type == "local_archive":
        target = Path(raw).expanduser()
        if not target.exists():
            return CameraProbeResult(False, "offline", f"Local archive path not found: {raw}", error="LOCAL_PATH_NOT_FOUND")
        if target.is_file():
            if target.suffix.lower() not in ALLOWED_VIDEO_EXTENSIONS:
                return CameraProbeResult(
                    False,
                    "offline",
                    f"Unsupported local video file extension: {target.suffix}",
                    error="UNSUPPORTED_EXTENSION",
                )
            try:
                meta = probe_video_file(target)
                if not meta.codec and not meta.width:
                    return CameraProbeResult(
                        False,
                        "offline",
                        "Local file exists but contains no decodable video stream.",
                        error="NO_VIDEO_STREAM",
                    )
                return CameraProbeResult(
                    True,
                    "online",
                    f"Verified local video source ({meta.codec or 'video'} {meta.width or '?'}x{meta.height or '?'}).",
                    codec=meta.codec,
                    width=meta.width,
                    height=meta.height,
                    fps=meta.fps,
                    discovered_files=1,
                )
            except Exception as exc:
                return CameraProbeResult(
                    False,
                    "offline",
                    sanitize_log_text(f"Local file inspection failed: {exc}", raw),
                    error="PROBE_FAILED",
                )
        if target.is_dir():
            files = discover_local_videos(raw)
            return CameraProbeResult(
                True,
                "online",
                f"Local archive directory accessible ({len(files)} video file(s) discovered).",
                discovered_files=len(files),
            )
        return CameraProbeResult(False, "offline", "Path is neither a regular file nor directory.", error="INVALID_PATH")

    clean_raw, url_user, url_pass = strip_uri_credentials(raw)
    eff_user = username if username is not None else url_user
    eff_pass = password if password is not None else url_pass

    parsed = urlparse(clean_raw)
    if not parsed.scheme or not parsed.hostname:
        return CameraProbeResult(False, "offline", "Invalid stream URI syntax (missing scheme or host).", error="INVALID_URI")

    if source_type == "onvif":
        if parsed.scheme.lower() in ("rtsp", "rtsps"):
            source_type = "rtsp"
        else:
            onvif_res = verify_onvif_and_rtsp(
                endpoint_url=clean_raw,
                username=eff_user,
                password=eff_pass,
                rtsp_transport=transport,
                stream_profile=stream_profile,
                timeout_sec=timeout_sec,
                rtsp_probe_fn=ffprobe_stream,
            )
            return CameraProbeResult(
                reachable=onvif_res.reachable,
                status=onvif_res.status,
                message=sanitize_log_text(onvif_res.message, raw, eff_pass),
                error=onvif_res.error,
                codec=onvif_res.codec,
                width=onvif_res.width,
                height=onvif_res.height,
                fps=onvif_res.fps,
                manufacturer=onvif_res.manufacturer,
                model=onvif_res.model,
                firmware_version=onvif_res.firmware_version,
                main_stream_uri=onvif_res.main_rtsp_uri,
                sub_stream_uri=onvif_res.sub_rtsp_uri,
                stages=onvif_res.stages.to_dict(),
            )

    if source_type == "rtsp":
        target_clean = (
            sub_stream_uri.strip()
            if (stream_profile == "sub" and sub_stream_uri)
            else (main_stream_uri.strip() if main_stream_uri else clean_raw)
        )
        t_parsed = urlparse(target_clean)
        if t_parsed.scheme.lower() not in ("rtsp", "rtsps"):
            return CameraProbeResult(False, "offline", "RTSP camera requires rtsp:// or rtsps:// URI.", error="INVALID_SCHEME")
        port = t_parsed.port or (322 if t_parsed.scheme.lower() == "rtsps" else 554)
        stages = VerificationStages(checked_at=_utc_now_iso())
        tcp_ok, tcp_err = _tcp_check(t_parsed.hostname or "", port, timeout_sec=min(timeout_sec, 3.0))
        if not tcp_ok:
            stages.error = tcp_err or "RTSP TCP handshake failed."
            return CameraProbeResult(False, "offline", stages.error, error="TCP_UNREACHABLE", stages=stages.to_dict())
        stages.device_discovered = True
        stages.rtsp_uri_retrieved = True

        runtime_uri = inject_uri_credentials(target_clean, eff_user, eff_pass)
        ok, info, probe_err = ffprobe_stream(runtime_uri, rtsp_transport=transport, timeout_sec=timeout_sec)
        if not ok:
            msg = sanitize_log_text(f"RTSP port {port} reachable, but stream handshake failed: {probe_err}", runtime_uri, eff_pass)
            stages.error = msg
            return CameraProbeResult(False, "offline", msg, error="RTSP_HANDSHAKE_FAILED", stages=stages.to_dict())
        stages.rtsp_stream_opened = True
        return CameraProbeResult(
            True,
            "online",
            f"RTSP ({transport.upper()}) stream verified ({info.get('codec') or 'video'} {info.get('width') or '?'}x{info.get('height') or '?'}).",
            codec=info.get("codec"),
            width=info.get("width"),
            height=info.get("height"),
            fps=info.get("fps"),
            main_stream_uri=main_stream_uri or clean_raw,
            sub_stream_uri=sub_stream_uri,
            stages=stages.to_dict(),
        )

    if source_type == "http":
        if parsed.scheme.lower() not in ("http", "https"):
            return CameraProbeResult(False, "offline", "HTTP camera requires http:// or https:// URI.", error="INVALID_SCHEME")
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        tcp_ok, tcp_err = _tcp_check(parsed.hostname, port, timeout_sec=min(timeout_sec, 3.0))
        if not tcp_ok:
            return CameraProbeResult(False, "offline", tcp_err or "HTTP host unreachable.", error="TCP_UNREACHABLE")
        runtime_uri = inject_uri_credentials(clean_raw, eff_user, eff_pass)
        ok, info, probe_err = ffprobe_stream(runtime_uri, timeout_sec=timeout_sec)
        if ok:
            return CameraProbeResult(
                True,
                "online",
                f"HTTP stream verified ({info.get('codec') or 'video'} {info.get('width') or '?'}x{info.get('height') or '?'}).",
                codec=info.get("codec"),
                width=info.get("width"),
                height=info.get("height"),
                fps=info.get("fps"),
            )
        return CameraProbeResult(
            False,
            "offline",
            sanitize_log_text(probe_err or "HTTP stream endpoint did not expose a valid video stream.", runtime_uri, eff_pass),
            error="HTTP_STREAM_INVALID",
        )

    return CameraProbeResult(False, "offline", f"Unsupported camera source type '{source_type}'.", error="UNSUPPORTED_SOURCE")
