"""CCTV Video Library endpoints with local storage, validation, range streaming, and FFmpeg inspection."""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import FileResponse

from backend.app.core.errors import LumaFluxError, NotFoundError, ValidationError
from backend.app.db.database import utc_now_iso
from video_processing.ffmpeg_probe import extract_thumbnail, is_ffmpeg_available, probe_video_file

router = APIRouter(prefix="/videos", tags=["videos"])

ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".ts"}
MAX_VIDEO_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GB


@router.get("")
def list_videos(request: Request) -> list[dict]:
    return request.app.state.repo.list_videos()


@router.post("/import", status_code=201)
async def import_video(
    request: Request,
    file: UploadFile = File(...),
    camera_id: str | None = Form(default=None),
) -> dict:
    config = request.app.state.config
    repo = request.app.state.repo
    settings = repo.get_settings()
    storage_dir = Path(settings.get("storage_directory", str(config.storage_dir)))
    thumb_dir = Path(settings.get("thumbnail_directory", str(config.thumbnail_dir)))
    storage_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise ValidationError(
            f"Unsupported video format '{ext}'. Allowed: {', '.join(sorted(ALLOWED_VIDEO_EXTENSIONS))}.",
            code="INVALID_FILE_TYPE",
        )

    video_id = str(uuid.uuid4())
    stored_filename = f"{video_id}{ext}"
    dest_path = storage_dir / stored_filename

    hasher = hashlib.sha256()
    size_bytes = 0
    try:
        with dest_path.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size_bytes += len(chunk)
                if size_bytes > MAX_VIDEO_UPLOAD_BYTES:
                    raise LumaFluxError(
                        "Video file exceeds the maximum Stage 1 upload size limit (1 GB).",
                        status_code=413,
                        code="FILE_TOO_LARGE",
                    )
                out.write(chunk)
                hasher.update(chunk)

        if size_bytes <= 0:
            raise ValidationError("Uploaded video file is empty (0 bytes).", code="EMPTY_FILE")

        meta = probe_video_file(dest_path)
        if is_ffmpeg_available() and not meta.codec and not meta.width and meta.duration_seconds is None:
            repo.write_audit_log(
                actor="Local Administrator",
                actor_role="admin",
                action="VIDEO_IMPORT_REJECTED",
                resource_type="video_file",
                details=f"Rejected unreadable/corrupt video file '{file.filename}'.",
                outcome="error",
            )
            raise LumaFluxError(
                "FFmpeg could not detect a valid video stream in the uploaded file.",
                status_code=422,
                code="INVALID_VIDEO_FILE",
            )
    except Exception:
        dest_path.unlink(missing_ok=True)
        raise

    thumb_path = thumb_dir / f"{video_id}.jpg"
    thumb_ok = extract_thumbnail(dest_path, thumb_path)
    now = utc_now_iso()

    with repo.db.connection() as conn:
        if camera_id:
            cam_exists = conn.execute("SELECT id FROM cameras WHERE id = ?", (camera_id,)).fetchone()
            if not cam_exists:
                dest_path.unlink(missing_ok=True)
                thumb_path.unlink(missing_ok=True)
                raise ValidationError("Referenced camera_id does not exist.")

        conn.execute(
            """
            INSERT INTO video_files
              (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes, duration_seconds, width, height, fps, codec, processing_status, error_message, recorded_at, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, NULL, ?)
            """,
            (
                video_id,
                camera_id or None,
                stored_filename,
                file.filename or stored_filename,
                str(dest_path),
                str(thumb_path) if thumb_ok else None,
                hasher.hexdigest(),
                size_bytes,
                meta.duration_seconds,
                meta.width,
                meta.height,
                meta.fps,
                meta.codec,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM video_files WHERE id = ?", (video_id,)).fetchone()

    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="VIDEO_IMPORTED",
        resource_type="video_file",
        resource_id=video_id,
        details=f"Imported CCTV file '{file.filename}' ({size_bytes} bytes)",
    )
    return dict(row)


@router.get("/{video_id}/thumbnail")
def get_video_thumbnail(video_id: str, request: Request) -> FileResponse:
    with request.app.state.repo.db.connection() as conn:
        row = conn.execute("SELECT thumbnail_path FROM video_files WHERE id = ?", (video_id,)).fetchone()
    if not row or not row["thumbnail_path"] or not Path(row["thumbnail_path"]).exists():
        raise NotFoundError("Thumbnail not found.")
    return FileResponse(row["thumbnail_path"], media_type="image/jpeg")


@router.get("/{video_id}/stream")
def stream_video(video_id: str, request: Request) -> FileResponse:
    with request.app.state.repo.db.connection() as conn:
        row = conn.execute("SELECT storage_path FROM video_files WHERE id = ?", (video_id,)).fetchone()
    if not row or not Path(row["storage_path"]).exists():
        raise NotFoundError("Video file not found on disk.")
    return FileResponse(row["storage_path"], media_type="video/mp4")


@router.post("/{video_id}/inspect")
def inspect_video_asset(video_id: str, request: Request) -> dict:
    repo = request.app.state.repo
    with repo.db.connection() as conn:
        row = conn.execute("SELECT * FROM video_files WHERE id = ?", (video_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Video {video_id} not found.")
        video_path = Path(row["storage_path"])
        if not video_path.exists():
            raise NotFoundError("Video file missing from local storage directory.")
        meta = probe_video_file(video_path)
        thumb_path = request.app.state.config.thumbnail_dir / f"{video_id}.jpg"
        thumb_ok = extract_thumbnail(video_path, thumb_path)
        conn.execute(
            """
            UPDATE video_files
            SET duration_seconds = ?, width = ?, height = ?, fps = ?, codec = ?, thumbnail_path = COALESCE(?, thumbnail_path), processing_status = 'ready'
            WHERE id = ?
            """,
            (
                meta.duration_seconds,
                meta.width,
                meta.height,
                meta.fps,
                meta.codec,
                str(thumb_path) if thumb_ok else None,
                video_id,
            ),
        )
        updated = conn.execute("SELECT * FROM video_files WHERE id = ?", (video_id,)).fetchone()
    return dict(updated)


@router.delete("/{video_id}")
def delete_video(video_id: str, request: Request) -> dict:
    repo = request.app.state.repo
    with repo.db.connection() as conn:
        row = conn.execute("SELECT * FROM video_files WHERE id = ?", (video_id,)).fetchone()
        if not row:
            raise NotFoundError(f"Video {video_id} not found.")
        crop_rows = conn.execute(
            "SELECT crop_path FROM person_events WHERE video_file_id = ? AND crop_path IS NOT NULL",
            (video_id,),
        ).fetchall()
        conn.execute("DELETE FROM video_files WHERE id = ?", (video_id,))

    for path_str in [row["storage_path"], row["thumbnail_path"], *[c["crop_path"] for c in crop_rows]]:
        if path_str:
            Path(path_str).unlink(missing_ok=True)

    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="VIDEO_DELETED",
        resource_type="video_file",
        resource_id=video_id,
        details=f"Deleted video '{row['original_name']}'",
    )
    return {"deleted": True, "id": video_id}
