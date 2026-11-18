"""Camera management, ONVIF discovery, probing, manual reconnect, live streaming, snapshots, and recording endpoints."""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from backend.app.core.errors import NotFoundError, PolicyViolationError, ValidationError
from backend.app.db.database import utc_now_iso
from video_processing.camera_connector import redact_stream_uri
from video_processing.camera_drivers import list_camera_drivers
from video_processing.ffmpeg_probe import extract_thumbnail
from video_processing.onvif_client import discover_onvif_devices
from video_processing.stream_worker import capture_single_snapshot_jpeg

router = APIRouter(prefix="/cameras", tags=["cameras"])
driver_router = APIRouter(tags=["cameras"])


@driver_router.get("/camera-drivers")
def get_camera_drivers() -> list[dict]:
    return list_camera_drivers()


class CameraCreateRequest(BaseModel):
    name: str
    location_zone: str
    source_type: str = "rtsp"
    vendor_driver: str | None = None
    stream_uri: str = ""
    ip_address: str | None = None
    rtsp_port: int = 554
    onvif_port: int = 80
    username: str | None = None
    password: str | None = None
    rtsp_transport: str = "tcp"
    stream_profile: str = "main"
    main_stream_uri: str | None = None
    sub_stream_uri: str | None = None
    connection_timeout_sec: float = 6.0
    nvr_id: str | None = None
    channel_number: int | None = None
    enabled: bool = True
    retention_days: int = 30
    recording_mode: str = "manual"
    max_reconnect_attempts: int = 5
    target_fps: float = 5.0
    target_resolution: str = "1280x720"
    recording_schedule: str | None = None


class CameraUpdateRequest(BaseModel):
    name: str | None = None
    location_zone: str | None = None
    vendor_driver: str | None = None
    stream_uri: str | None = None
    ip_address: str | None = None
    rtsp_port: int | None = None
    onvif_port: int | None = None
    username: str | None = None
    password: str | None = None
    clear_password: bool | None = None
    rtsp_transport: str | None = None
    stream_profile: str | None = None
    main_stream_uri: str | None = None
    sub_stream_uri: str | None = None
    connection_timeout_sec: float | None = None
    status: str | None = None
    enabled: bool | None = None
    retention_days: int | None = None
    recording_mode: str | None = None
    max_reconnect_attempts: int | None = None
    target_fps: float | None = None
    target_resolution: str | None = None
    recording_schedule: str | None = None


class CameraDiscoverRequest(BaseModel):
    timeout_sec: float = 2.0
    target_host: str | None = None
    target_port: int = 3702


def _sync_manager_limits(repo, mgr) -> None:
    settings = repo.get_settings()
    try:
        max_s = int(settings.get("max_concurrent_streams", "8") or "8")
        max_r = int(settings.get("max_concurrent_recordings", "8") or "8")
        mgr.configure_limits(max_streams=max_s, max_recordings=max_r)
    except ValueError:
        pass


@router.get("")
def list_cameras(request: Request) -> list[dict]:
    return request.app.state.repo.list_cameras()


@router.post("/discover")
def discover_cameras(payload: CameraDiscoverRequest, request: Request) -> dict:
    devices = discover_onvif_devices(
        timeout_sec=min(max(payload.timeout_sec, 0.4), 6.0),
        target_host=payload.target_host.strip() if payload.target_host else None,
        target_port=payload.target_port,
    )
    request.app.state.repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="ONVIF_DISCOVERY_SCAN",
        resource_type="camera",
        details=f"ONVIF WS-Discovery scan completed ({len(devices)} device(s) responded)",
    )
    return {"discovered_count": len(devices), "devices": devices}


@router.post("", status_code=201)
def create_camera(payload: CameraCreateRequest, request: Request) -> dict:
    return request.app.state.repo.create_camera(payload.model_dump())


@router.patch("/{camera_id}")
def update_camera(camera_id: str, payload: CameraUpdateRequest, request: Request) -> dict:
    return request.app.state.repo.update_camera(camera_id, payload.model_dump(exclude_none=True))


@router.post("/{camera_id}/check")
def check_camera(camera_id: str, request: Request) -> dict:
    return request.app.state.repo.check_camera(camera_id)


@router.post("/{camera_id}/stream-test")
def stream_test_camera(camera_id: str, request: Request) -> dict:
    return request.app.state.repo.stream_test_camera(camera_id)


@router.post("/{camera_id}/reconnect")
def reconnect_camera(camera_id: str, request: Request) -> dict:
    repo = request.app.state.repo
    mgr = request.app.state.stream_manager
    _sync_manager_limits(repo, mgr)

    was_streaming = mgr.get_worker(camera_id) is not None
    if was_streaming:
        mgr.stop_stream(camera_id)

    check_res = repo.check_camera(camera_id)
    stream_session = None
    if check_res["camera"]["enabled"] and check_res["probe"]["reachable"]:
        cam, runtime_uri, rtsp_transport = repo.resolve_camera_runtime(camera_id)
        session_id = str(uuid.uuid4())
        now = utc_now_iso()
        transport_label = f"ffmpeg-{rtsp_transport}" if cam["source_type"] in ("rtsp", "onvif") else "ffmpeg"
        with repo.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO camera_stream_sessions
                  (id, camera_id, status, transport, sample_fps, resolution, frames_captured, frames_dropped, bytes_received, reconnect_count, started_at)
                VALUES (?, ?, 'starting', ?, ?, ?, 0, 0, 0, 0, ?)
                """,
                (
                    session_id,
                    camera_id,
                    transport_label,
                    float(cam.get("target_fps") or 5.0),
                    cam.get("target_resolution") or "1280x720",
                    now,
                ),
            )

        def _on_state(st) -> None:
            with repo.db.connection() as conn:
                conn.execute(
                    """
                    UPDATE camera_stream_sessions
                    SET status = ?, frames_captured = ?, frames_dropped = ?, bytes_received = ?, avg_frame_ms = ?,
                        reconnect_count = ?, last_frame_at = ?, error_message = ?, stopped_at = COALESCE(?, stopped_at)
                    WHERE id = ?
                    """,
                    (
                        st.status,
                        st.frames_captured,
                        st.frames_dropped,
                        st.bytes_received,
                        st.avg_frame_ms,
                        st.reconnect_count,
                        st.last_frame_at,
                        st.error_message,
                        st.stopped_at,
                        st.session_id,
                    ),
                )

        st = mgr.start_stream(
            session_id=session_id,
            camera_id=camera_id,
            source_type=cam["source_type"],
            stream_uri=runtime_uri,
            sample_fps=float(cam.get("target_fps") or 5.0),
            resolution=cam.get("target_resolution") or "1280x720",
            max_reconnect_attempts=int(cam.get("max_reconnect_attempts") or 5),
            rtsp_transport=rtsp_transport,
            on_state_change=_on_state,
        )
        stream_session = st.__dict__

    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="CAMERA_MANUAL_RECONNECT",
        resource_type="camera",
        resource_id=camera_id,
        details=f"Manual reconnect on '{check_res['camera']['name']}': {check_res['message']}",
        outcome="success" if check_res["probe"]["reachable"] else "error",
    )
    return {**check_res, "stream_restarted": stream_session is not None, "session": stream_session}


@router.post("/{camera_id}/ingest-local", status_code=201)
def ingest_local_videos(camera_id: str, request: Request) -> dict:
    ingested = request.app.state.repo.ingest_local_camera_videos(camera_id)
    return {"ingested_count": len(ingested), "videos": ingested}


@router.post("/{camera_id}/stream/start", status_code=201)
def start_camera_stream(camera_id: str, request: Request) -> dict:
    repo = request.app.state.repo
    mgr = request.app.state.stream_manager
    _sync_manager_limits(repo, mgr)

    cam, runtime_uri, rtsp_transport = repo.resolve_camera_runtime(camera_id)
    if not cam["enabled"]:
        raise PolicyViolationError("Enable camera before starting live stream.")

    session_id = str(uuid.uuid4())
    now = utc_now_iso()
    transport_label = f"ffmpeg-{rtsp_transport}" if cam["source_type"] in ("rtsp", "onvif") else "ffmpeg"
    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO camera_stream_sessions
              (id, camera_id, status, transport, sample_fps, resolution, frames_captured, frames_dropped, bytes_received, reconnect_count, started_at)
            VALUES (?, ?, 'starting', ?, ?, ?, 0, 0, 0, 0, ?)
            """,
            (session_id, camera_id, transport_label, float(cam.get("target_fps") or 5.0), cam.get("target_resolution") or "1280x720", now),
        )

    def _on_state(st) -> None:
        with repo.db.connection() as conn:
            conn.execute(
                """
                UPDATE camera_stream_sessions
                SET status = ?, frames_captured = ?, frames_dropped = ?, bytes_received = ?, avg_frame_ms = ?,
                    reconnect_count = ?, last_frame_at = ?, error_message = ?, stopped_at = COALESCE(?, stopped_at)
                WHERE id = ?
                """,
                (
                    st.status,
                    st.frames_captured,
                    st.frames_dropped,
                    st.bytes_received,
                    st.avg_frame_ms,
                    st.reconnect_count,
                    st.last_frame_at,
                    st.error_message,
                    st.stopped_at,
                    st.session_id,
                ),
            )

    try:
        state = mgr.start_stream(
            session_id=session_id,
            camera_id=camera_id,
            source_type=cam["source_type"],
            stream_uri=runtime_uri,
            sample_fps=float(cam.get("target_fps") or 5.0),
            resolution=cam.get("target_resolution") or "1280x720",
            max_reconnect_attempts=int(cam.get("max_reconnect_attempts") or 5),
            rtsp_transport=rtsp_transport,
            on_state_change=_on_state,
        )
    except RuntimeError as exc:
        with repo.db.connection() as conn:
            conn.execute(
                "UPDATE camera_stream_sessions SET status = 'error', error_message = ?, stopped_at = ? WHERE id = ?",
                (str(exc), utc_now_iso(), session_id),
            )
        raise ValidationError(str(exc), code="STREAM_LIMIT_REACHED") from exc

    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="CAMERA_STREAM_STARTED",
        resource_type="camera_stream_session",
        resource_id=session_id,
        details=f"Started live stream for '{cam['name']}' ({redact_stream_uri(cam['stream_uri'])})",
    )
    return state.__dict__


@router.post("/{camera_id}/stream/stop")
def stop_camera_stream(camera_id: str, request: Request) -> dict:
    repo = request.app.state.repo
    mgr = request.app.state.stream_manager
    cam, _, _ = repo.resolve_camera_runtime(camera_id)
    state = mgr.stop_stream(camera_id)
    if state:
        repo.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="CAMERA_STREAM_STOPPED",
            resource_type="camera_stream_session",
            resource_id=state.session_id,
            details=f"Stopped live stream for '{cam['name']}' ({state.frames_captured} frames)",
        )
    return {"stopped": state is not None, "session": state.__dict__ if state else None}


@router.get("/{camera_id}/snapshot")
def get_camera_snapshot(
    camera_id: str,
    request: Request,
    capture: Optional[str] = Query(default=None),
) -> Response:
    worker = request.app.state.stream_manager.get_worker(camera_id)
    frame = worker.get_latest_frame() if worker else None
    if not frame and capture in ("1", "true"):
        cam, runtime_uri, rtsp_transport = request.app.state.repo.resolve_camera_runtime(camera_id)
        frame = capture_single_snapshot_jpeg(cam["source_type"], runtime_uri, rtsp_transport)
    if not frame:
        raise NotFoundError("No active stream frame captured yet.")
    return Response(content=frame, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/{camera_id}/stream/mjpeg")
def stream_camera_mjpeg(camera_id: str, request: Request) -> StreamingResponse:
    worker = request.app.state.stream_manager.get_worker(camera_id)
    if not worker:
        raise NotFoundError("Camera live stream is not running.")

    def _frame_iter():
        while worker.state.status in ("starting", "streaming", "reconnecting"):
            frame = worker.get_latest_frame() or worker.wait_next_frame(timeout=2.0)
            if frame:
                yield (
                    b"--lumafluxframe\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    + f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii")
                    + frame
                    + b"\r\n"
                )
            time.sleep(max(0.05, 1.0 / max(worker.state.sample_fps, 1.0)))

    return StreamingResponse(
        _frame_iter(),
        media_type="multipart/x-mixed-replace; boundary=lumafluxframe",
        headers={"Cache-Control": "no-cache, no-store"},
    )


@router.post("/{camera_id}/recording/start", status_code=201)
def start_camera_recording(camera_id: str, request: Request) -> dict:
    repo = request.app.state.repo
    mgr = request.app.state.stream_manager
    _sync_manager_limits(repo, mgr)

    cam, runtime_uri, rtsp_transport = repo.resolve_camera_runtime(camera_id)
    if not cam["enabled"]:
        raise PolicyViolationError("Enable camera before starting recording.")
    settings = repo.get_settings()
    storage_dir = Path(settings.get("storage_directory", str(repo.db.config.storage_dir)))
    stamp = utc_now_iso().replace(":", "-")
    output_path = storage_dir / "cameras" / camera_id / f"rec_{stamp}.mp4"
    try:
        rec_id = mgr.start_recording(
            camera_id,
            cam["source_type"],
            runtime_uri,
            output_path,
            rtsp_transport=rtsp_transport,
        )
    except RuntimeError as exc:
        raise ValidationError(str(exc)) from exc
    now = utc_now_iso()
    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO recording_sessions (id, camera_id, trigger_mode, status, output_path, file_size_bytes, started_at)
            VALUES (?, ?, 'manual', 'recording', ?, 0, ?)
            """,
            (rec_id, camera_id, str(output_path), now),
        )
        row = conn.execute("SELECT * FROM recording_sessions WHERE id = ?", (rec_id,)).fetchone()
    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="CAMERA_RECORDING_STARTED",
        resource_type="recording_session",
        resource_id=rec_id,
        details=f"Started manual recording for '{cam['name']}'",
    )
    return dict(row)


@router.post("/{camera_id}/recording/stop")
def stop_camera_recording(camera_id: str, request: Request) -> dict:
    repo = request.app.state.repo
    mgr = request.app.state.stream_manager
    cam, _, _ = repo.resolve_camera_runtime(camera_id)
    res = mgr.stop_recording(camera_id)
    if not res:
        raise NotFoundError("No active recording session for this camera.")

    ended_at = utc_now_iso()
    rec_id = res["recording_id"]
    if not res.get("valid"):
        err_msg = res.get("error") or "Recording invalid, empty, or failed FFmpeg decode verification."
        with repo.db.connection() as conn:
            conn.execute(
                "UPDATE recording_sessions SET status = 'failed', file_size_bytes = ?, error_message = ?, ended_at = ? WHERE id = ?",
                (res.get("size_bytes", 0), err_msg, ended_at, rec_id),
            )
            row = conn.execute("SELECT * FROM recording_sessions WHERE id = ?", (rec_id,)).fetchone()
        return dict(row)

    output_path = Path(res["output_path"])
    settings = repo.get_settings()
    thumb_dir = Path(settings.get("thumbnail_directory", str(repo.db.config.thumbnail_dir)))
    video_id = str(uuid.uuid4())
    thumb_path = thumb_dir / f"{video_id}.jpg"
    thumb_ok = extract_thumbnail(output_path, thumb_path)
    meta = res["metadata"]
    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO video_files
              (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes,
               duration_seconds, width, height, fps, codec, processing_status, recorded_at, recording_session_id, source_origin, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 'recorded', ?)
            """,
            (
                video_id,
                camera_id,
                output_path.name,
                output_path.name,
                str(output_path),
                str(thumb_path) if thumb_ok else None,
                res["sha256"],
                res["size_bytes"],
                meta.get("duration_seconds"),
                meta.get("width"),
                meta.get("height"),
                meta.get("fps"),
                meta.get("codec"),
                ended_at,
                rec_id,
                ended_at,
            ),
        )
        conn.execute(
            """
            UPDATE recording_sessions
            SET status = 'completed', video_file_id = ?, file_size_bytes = ?, duration_seconds = ?, ended_at = ?
            WHERE id = ?
            """,
            (video_id, res["size_bytes"], meta.get("duration_seconds"), ended_at, rec_id),
        )
        row = conn.execute("SELECT * FROM recording_sessions WHERE id = ?", (rec_id,)).fetchone()
    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="CAMERA_RECORDING_STOPPED",
        resource_type="recording_session",
        resource_id=rec_id,
        details=f"Stopped recording for '{cam['name']}' ({res['size_bytes']} bytes)",
    )
    return dict(row)


@router.delete("/{camera_id}")
def delete_camera(camera_id: str, request: Request) -> dict:
    mgr = request.app.state.stream_manager
    mgr.stop_recording(camera_id)
    mgr.stop_stream(camera_id)
    request.app.state.repo.delete_camera(camera_id)
    return {"deleted": True, "id": camera_id}
