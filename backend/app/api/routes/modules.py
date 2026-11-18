"""Stage 1 & Stage 2 endpoints for Person Gallery, Anonymous Tracks, AI Detection, Privacy Redaction, Watchlist Review, and Reports."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ai_engine.person_detector import detect_persons_in_video
from ai_engine.privacy_filter import export_privacy_masked_video
from ai_engine.registry import get_registered_engines, run_stage1_safe_pipeline
from backend.app.core.errors import NotFoundError, PolicyViolationError, ValidationError
from backend.app.db.database import utc_now_iso
from video_processing.ffmpeg_probe import extract_thumbnail

router = APIRouter(tags=["modules"])


class AiJobRequest(BaseModel):
    video_file_id: str
    engine_id: str
    sample_fps: Optional[float] = None
    confidence_threshold: Optional[float] = None


class PersonEventUpdateRequest(BaseModel):
    status: Optional[str] = None
    profile_id: Optional[str] = None
    reviewed_by: Optional[str] = None
    notes: Optional[str] = None


class GalleryCollectionCreateRequest(BaseModel):
    name: str
    description: str = ""


class GalleryCollectionItemRequest(BaseModel):
    event_id: str


class VideoRedactRequest(BaseModel):
    mode: str = "blur"
    regions: Optional[list[dict]] = None


class WatchlistCreateRequest(BaseModel):
    title: str
    priority: str = "medium"
    reason: str
    profile_id: str | None = None
    video_file_id: str | None = None
    event_id: str | None = None
    assigned_to: str = "Security Operator"
    reviewer_notes: str = ""


class WatchlistUpdateRequest(BaseModel):
    status: str | None = None
    reviewer_notes: str | None = None


@router.get("/person-events")
def list_person_events(
    request: Request,
    camera_id: Optional[str] = Query(default=None),
    video_file_id: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    track_id: Optional[str] = Query(default=None),
) -> list[dict]:
    clauses: list[str] = []
    params: list[str] = []
    if camera_id:
        clauses.append("e.camera_id = ?")
        params.append(camera_id)
    if video_file_id:
        clauses.append("e.video_file_id = ?")
        params.append(video_file_id)
    if status:
        clauses.append("e.status = ?")
        params.append(status)
    if track_id:
        clauses.append("e.anonymous_track_id = ?")
        params.append(track_id)

    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with request.app.state.repo.db.connection() as conn:
        rows = conn.execute(
            f"""
            SELECT e.*, v.original_name AS video_name, c.name AS camera_name, t.track_code AS track_code
            FROM person_events e
            LEFT JOIN video_files v ON e.video_file_id = v.id
            LEFT JOIN cameras c ON e.camera_id = c.id
            LEFT JOIN anonymous_tracks t ON e.anonymous_track_id = t.id
            {where_sql}
            ORDER BY e.created_at DESC
            """,
            params,
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/person-events/{event_id}/thumbnail")
def get_person_event_thumbnail(event_id: str, request: Request) -> FileResponse:
    with request.app.state.repo.db.connection() as conn:
        row = conn.execute("SELECT crop_path FROM person_events WHERE id = ?", (event_id,)).fetchone()
    if not row or not row["crop_path"] or not Path(row["crop_path"]).exists():
        raise NotFoundError("Event thumbnail not found.")
    return FileResponse(path=row["crop_path"], media_type="image/jpeg")


@router.patch("/person-events/{event_id}")
def update_person_event(event_id: str, payload: PersonEventUpdateRequest, request: Request) -> dict:
    repo = request.app.state.repo
    settings = repo.get_settings()
    with repo.db.connection() as conn:
        existing = conn.execute("SELECT * FROM person_events WHERE id = ?", (event_id,)).fetchone()
        if not existing:
            raise NotFoundError("Person event not found.")

        next_status = (
            payload.status
            if payload.status in ("unreviewed", "clustered", "linked", "dismissed")
            else existing["status"]
        )
        next_profile_id = existing["profile_id"]
        if payload.profile_id is not None:
            if payload.profile_id == "":
                next_profile_id = None
            else:
                prof = conn.execute("SELECT * FROM person_profiles WHERE id = ?", (payload.profile_id,)).fetchone()
                if not prof:
                    raise NotFoundError("Referenced person profile not found.")
                if settings.get("require_consent_for_profiles") == "true" and prof["consent_status"] != "granted":
                    raise PolicyViolationError("Cannot link event to a profile without granted consent.")
                next_profile_id = payload.profile_id
                if next_status == "unreviewed":
                    next_status = "linked"

        now = utc_now_iso()
        reviewer = (payload.reviewed_by or "Local Administrator").strip()
        next_notes = payload.notes.strip() if payload.notes is not None else (existing["notes"] if "notes" in existing.keys() else "")
        conn.execute(
            "UPDATE person_events SET status = ?, profile_id = ?, notes = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
            (next_status, next_profile_id, next_notes, reviewer, now, event_id),
        )
        updated = conn.execute(
            """
            SELECT e.*, v.original_name AS video_name, c.name AS camera_name, t.track_code AS track_code
            FROM person_events e
            LEFT JOIN video_files v ON e.video_file_id = v.id
            LEFT JOIN cameras c ON e.camera_id = c.id
            LEFT JOIN anonymous_tracks t ON e.anonymous_track_id = t.id
            WHERE e.id = ?
            """,
            (event_id,),
        ).fetchone()
    repo.write_audit_log(
        actor=reviewer,
        actor_role="admin",
        action="PERSON_EVENT_REVIEWED",
        resource_type="person_event",
        resource_id=event_id,
        details=f"Event updated to status='{next_status}'",
    )
    return dict(updated)


@router.delete("/person-events/{event_id}")
def delete_person_event(event_id: str, request: Request) -> dict:
    repo = request.app.state.repo
    with repo.db.connection() as conn:
        existing = conn.execute("SELECT crop_path FROM person_events WHERE id = ?", (event_id,)).fetchone()
        if not existing:
            raise NotFoundError("Person event not found.")
        crop_path = existing["crop_path"]
        conn.execute("DELETE FROM person_events WHERE id = ?", (event_id,))
    if crop_path and Path(crop_path).exists():
        try:
            Path(crop_path).unlink()
        except OSError:
            pass
    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="PERSON_EVENT_DELETED",
        resource_type="person_event",
        resource_id=event_id,
        details="Deleted person event and thumbnail per operator/retention request.",
    )
    return {"deleted": True, "id": event_id}


@router.get("/gallery/collections")
def list_gallery_collections(request: Request) -> list[dict]:
    return request.app.state.repo.list_gallery_collections()


@router.post("/gallery/collections", status_code=201)
def create_gallery_collection(payload: GalleryCollectionCreateRequest, request: Request) -> dict:
    return request.app.state.repo.create_gallery_collection(payload.model_dump())


@router.delete("/gallery/collections/{collection_id}")
def delete_gallery_collection(collection_id: str, request: Request) -> dict:
    request.app.state.repo.delete_gallery_collection(collection_id)
    return {"deleted": True, "id": collection_id}


@router.post("/gallery/collections/{collection_id}/items", status_code=201)
def add_gallery_collection_item(
    collection_id: str, payload: GalleryCollectionItemRequest, request: Request
) -> dict:
    return request.app.state.repo.add_gallery_collection_item(collection_id, payload.event_id)


@router.delete("/gallery/collections/{collection_id}/items/{event_id}")
def remove_gallery_collection_item(collection_id: str, event_id: str, request: Request) -> dict:
    return request.app.state.repo.remove_gallery_collection_item(collection_id, event_id)


@router.get("/anonymous-tracks")
def list_anonymous_tracks(request: Request) -> list[dict]:
    with request.app.state.repo.db.connection() as conn:
        rows = conn.execute(
            """
            SELECT t.*, c.name AS camera_name
            FROM anonymous_tracks t
            LEFT JOIN cameras c ON t.camera_id = c.id
            ORDER BY t.created_at DESC
            LIMIT 200
            """
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/videos/{video_id}/events")
def list_video_events(video_id: str, request: Request) -> list[dict]:
    with request.app.state.repo.db.connection() as conn:
        rows = conn.execute(
            """
            SELECT e.*, v.original_name AS video_name, c.name AS camera_name, t.track_code AS track_code
            FROM person_events e
            LEFT JOIN video_files v ON e.video_file_id = v.id
            LEFT JOIN cameras c ON e.camera_id = c.id
            LEFT JOIN anonymous_tracks t ON e.anonymous_track_id = t.id
            WHERE e.video_file_id = ?
            ORDER BY e.event_timestamp_sec ASC
            """,
            (video_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/videos/{video_id}/redact", status_code=201)
def redact_video(video_id: str, payload: VideoRedactRequest, request: Request) -> dict:
    repo = request.app.state.repo
    mode = "pixelate" if payload.mode == "pixelate" else "blur"
    with repo.db.connection() as conn:
        video = conn.execute("SELECT * FROM video_files WHERE id = ?", (video_id,)).fetchone()
        if not video:
            raise NotFoundError("Video file not found.")
        regions = payload.regions
        if regions is None:
            evt_rows = conn.execute(
                "SELECT bbox_json FROM person_events WHERE video_file_id = ? AND bbox_json IS NOT NULL",
                (video_id,),
            ).fetchall()
            regions = []
            for er in evt_rows:
                try:
                    regions.append(json.loads(er["bbox_json"]))
                except Exception:
                    pass

    storage_dir, thumb_dir = repo.get_directories()
    export_id = str(uuid.uuid4())
    stem = Path(video["original_name"]).stem
    export_name = f"{stem}_redacted_{mode}_{export_id[:6]}.mp4"
    out_path = storage_dir / "redacted" / export_name

    exported = export_privacy_masked_video(
        input_path=Path(video["storage_path"]),
        output_path=out_path,
        regions=regions or [],
        mode=mode,  # type: ignore[arg-type]
    )
    thumb_path = thumb_dir / f"{export_id}.jpg"
    thumb_ok = extract_thumbnail(out_path, thumb_path)
    meta = exported["metadata"]
    now = utc_now_iso()

    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO video_files
              (id, camera_id, filename, original_name, storage_path, thumbnail_path, sha256_hash, file_size_bytes,
               duration_seconds, width, height, fps, codec, processing_status, error_message, recorded_at,
               source_origin, imported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, 'redacted_export', ?)
            """,
            (
                export_id,
                video["camera_id"],
                export_name,
                export_name,
                str(out_path),
                str(thumb_path) if thumb_ok else None,
                exported["sha256"],
                exported["size_bytes"],
                meta.get("duration_seconds"),
                meta.get("width"),
                meta.get("height"),
                meta.get("fps"),
                meta.get("codec"),
                video["recorded_at"],
                now,
            ),
        )
        created = conn.execute("SELECT * FROM video_files WHERE id = ?", (export_id,)).fetchone()

    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="VIDEO_PRIVACY_EXPORTED",
        resource_type="video_file",
        resource_id=export_id,
        details=f"Exported {mode}-masked video '{export_name}' ({exported['regions_masked']} region(s))",
    )
    return dict(created)


@router.post("/retention/enforce")
def enforce_retention(request: Request) -> dict:
    repo = request.app.state.repo
    now_iso = utc_now_iso()
    deleted_videos = 0
    with repo.db.connection() as conn:
        expired_videos = conn.execute(
            "SELECT id, storage_path, thumbnail_path FROM video_files WHERE expires_at IS NOT NULL AND expires_at <= ?",
            (now_iso,),
        ).fetchall()
        for vid in expired_videos:
            crops = conn.execute("SELECT crop_path FROM person_events WHERE video_file_id = ?", (vid["id"],)).fetchall()
            for c in crops:
                if c["crop_path"]:
                    Path(c["crop_path"]).unlink(missing_ok=True)
            conn.execute("DELETE FROM video_files WHERE id = ?", (vid["id"],))
            for p in (vid["storage_path"], vid["thumbnail_path"]):
                if p:
                    Path(p).unlink(missing_ok=True)
            deleted_videos += 1

        cur = conn.execute(
            "DELETE FROM person_events WHERE status = 'dismissed' AND created_at <= datetime('now', '-30 days')"
        )
        orphaned_purged = int(cur.rowcount or 0)

    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="RETENTION_ENFORCED",
        resource_type="system",
        details=f"Retention sweep removed {deleted_videos} expired video(s) and {orphaned_purged} old dismissed event(s).",
    )
    return {"expired_videos_deleted": deleted_videos, "orphaned_events_purged": orphaned_purged}


@router.get("/ai/engines")
def list_ai_engines() -> list[dict]:
    return get_registered_engines()


@router.get("/ai/jobs")
def list_ai_jobs(request: Request) -> list[dict]:
    with request.app.state.repo.db.connection() as conn:
        rows = conn.execute(
            """
            SELECT j.*, v.original_name AS video_name
            FROM processing_jobs j
            LEFT JOIN video_files v ON j.video_file_id = v.id
            ORDER BY j.created_at DESC
            LIMIT 50
            """
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/ai/jobs", status_code=201)
def run_ai_job(payload: AiJobRequest, request: Request) -> dict:
    repo = request.app.state.repo
    settings = repo.get_settings()
    with repo.db.connection() as conn:
        video = conn.execute("SELECT * FROM video_files WHERE id = ?", (payload.video_file_id,)).fetchone()
        if not video:
            raise NotFoundError("Target video file not found.")

    if payload.engine_id == "biometric-matching-guard":
        msg = "Biometric identification is disabled by LumaFlux privacy policy."
        repo.write_audit_log(
            actor="Local Administrator",
            actor_role="admin",
            action="BIOMETRIC_PIPELINE_DENIED",
            resource_type="processing_job",
            resource_id=payload.video_file_id,
            details=msg,
            outcome="denied",
        )
        raise PolicyViolationError(msg)

    job_id = str(uuid.uuid4())
    now = utc_now_iso()
    job_type = "metadata_probe" if payload.engine_id == "ffmpeg-media-inspector" else "ai_person_detect"

    if payload.engine_id in ("opencv-person-detector", "opencv-motion-detector"):
        _, thumb_dir = repo.get_directories()
        sample_fps = payload.sample_fps or float(settings.get("detection_sample_fps", "2.0") or "2.0")
        threshold = payload.confidence_threshold or float(settings.get("detection_confidence_threshold", "0.45") or "0.45")
        det_res = detect_persons_in_video(
            video_path=Path(video["storage_path"]),
            video_file_id=video["id"],
            camera_id=video["camera_id"],
            engine_id=payload.engine_id,
            sample_fps=sample_fps,
            confidence_threshold=threshold,
            crop_dir=thumb_dir / "events",
            apply_privacy_blur=settings.get("privacy_blur_default", "true") == "true",
        )
        job_status = "completed" if det_res.executed else ("failed" if det_res.status == "failed" else "skipped")
        progress = 100 if det_res.executed else 0
        log_output = det_res.reason

        with repo.db.connection() as conn:
            if det_res.executed:
                for trk in det_res.tracks:
                    conn.execute(
                        """
                        INSERT INTO anonymous_tracks
                          (id, track_code, camera_id, video_file_id, stream_session_id, first_seen_sec, last_seen_sec,
                           event_count, best_confidence, status, created_at, updated_at)
                        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'closed', ?, ?)
                        """,
                        (
                            trk["track_id"],
                            trk["track_code"],
                            trk["camera_id"],
                            trk["video_file_id"],
                            trk["first_seen_sec"],
                            trk["last_seen_sec"],
                            trk["event_count"],
                            trk["best_confidence"],
                            now,
                            now,
                        ),
                    )
                for evt in det_res.events:
                    conn.execute(
                        """
                        INSERT INTO person_events
                          (id, video_file_id, camera_id, profile_id, anonymous_track_id, event_timestamp_sec,
                           end_timestamp_sec, confidence, frame_number, frame_count, bbox_json, crop_path,
                           model_name, status, created_at)
                        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?)
                        """,
                        (
                            evt["event_id"],
                            evt["video_file_id"],
                            evt["camera_id"],
                            evt["track_id"],
                            evt["best_timestamp_sec"],
                            evt["end_timestamp_sec"],
                            evt["peak_confidence"],
                            evt["best_frame_number"],
                            evt["frame_count"],
                            json.dumps(evt["best_bbox"]),
                            evt["crop_path"],
                            evt["model_name"],
                            now,
                        ),
                    )
                    if evt.get("crop_path"):
                        masked_on = settings.get("privacy_blur_default", "true") == "true"
                        conn.execute(
                            """
                            INSERT INTO event_thumbnails (id, event_id, file_path, width, height, privacy_masked, mask_mode, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                str(uuid.uuid4()),
                                evt["event_id"],
                                evt["crop_path"],
                                evt["best_bbox"].get("w"),
                                evt["best_bbox"].get("h"),
                                1 if masked_on else 0,
                                "blur" if masked_on else "none",
                                now,
                            ),
                        )

            conn.execute(
                """
                INSERT INTO processing_jobs
                  (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (job_id, payload.video_file_id, job_type, payload.engine_id, job_status, progress, log_output, now, now, now),
            )
            job = conn.execute(
                """
                SELECT j.*, v.original_name AS video_name
                FROM processing_jobs j
                LEFT JOIN video_files v ON j.video_file_id = v.id
                WHERE j.id = ?
                """,
                (job_id,),
            ).fetchone()
        return dict(job)

    res = run_stage1_safe_pipeline(payload.engine_id, payload.video_file_id)
    job_status = "completed" if res.executed else "skipped"
    progress = 100 if res.executed else 0

    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO processing_jobs
              (id, video_file_id, job_type, engine_name, status, progress_pct, log_output, started_at, completed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (job_id, payload.video_file_id, job_type, payload.engine_id, job_status, progress, res.reason, now, now, now),
        )
        job = conn.execute(
            """
            SELECT j.*, v.original_name AS video_name
            FROM processing_jobs j
            LEFT JOIN video_files v ON j.video_file_id = v.id
            WHERE j.id = ?
            """,
            (job_id,),
        ).fetchone()
    return dict(job)


@router.get("/watchlist-reviews")
def list_watchlist_reviews(request: Request) -> list[dict]:
    with request.app.state.repo.db.connection() as conn:
        rows = conn.execute(
            """
            SELECT w.*, p.display_name AS profile_name, v.original_name AS video_name
            FROM watchlist_reviews w
            LEFT JOIN person_profiles p ON w.profile_id = p.id
            LEFT JOIN video_files v ON w.video_file_id = v.id
            ORDER BY w.updated_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/watchlist-reviews", status_code=201)
def create_watchlist_review(payload: WatchlistCreateRequest, request: Request) -> dict:
    if not payload.title.strip() or not payload.reason.strip():
        raise ValidationError("Review title and reason are required.")
    priority = payload.priority if payload.priority in ("low", "medium", "high", "critical") else "medium"
    review_id = str(uuid.uuid4())
    now = utc_now_iso()
    repo = request.app.state.repo
    with repo.db.connection() as conn:
        conn.execute(
            """
            INSERT INTO watchlist_reviews
              (id, title, profile_id, video_file_id, event_id, priority, status, reason, reviewer_notes, assigned_to, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
            """,
            (
                review_id,
                payload.title.strip(),
                payload.profile_id or None,
                payload.video_file_id or None,
                payload.event_id or None,
                priority,
                payload.reason.strip(),
                payload.reviewer_notes.strip(),
                payload.assigned_to.strip() or "Security Operator",
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM watchlist_reviews WHERE id = ?", (review_id,)).fetchone()
    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="WATCHLIST_REVIEW_CREATED",
        resource_type="watchlist_review",
        resource_id=review_id,
        details=f"Opened {priority} security review '{payload.title.strip()}'",
    )
    return dict(row)


@router.patch("/watchlist-reviews/{review_id}")
def update_watchlist_review(review_id: str, payload: WatchlistUpdateRequest, request: Request) -> dict:
    repo = request.app.state.repo
    with repo.db.connection() as conn:
        existing = conn.execute("SELECT * FROM watchlist_reviews WHERE id = ?", (review_id,)).fetchone()
        if not existing:
            raise NotFoundError("Review item not found.")
        next_status = payload.status if payload.status in ("pending", "in_review", "approved", "dismissed", "escalated") else existing["status"]
        now = utc_now_iso()
        conn.execute(
            "UPDATE watchlist_reviews SET status = ?, reviewer_notes = ?, updated_at = ? WHERE id = ?",
            (
                next_status,
                payload.reviewer_notes.strip() if payload.reviewer_notes is not None else existing["reviewer_notes"],
                now,
                review_id,
            ),
        )
        updated = conn.execute("SELECT * FROM watchlist_reviews WHERE id = ?", (review_id,)).fetchone()
    return dict(updated)


@router.get("/reports/summary")
def get_reports_summary(request: Request) -> dict:
    repo = request.app.state.repo
    with repo.db.connection() as conn:
        cameras = [dict(r) for r in conn.execute("SELECT id, name, location_zone, source_type, status, enabled, retention_days FROM cameras").fetchall()]
        videos = [dict(r) for r in conn.execute("SELECT id, original_name, file_size_bytes, duration_seconds, codec, processing_status, imported_at FROM video_files").fetchall()]
        profiles = [dict(r) for r in conn.execute("SELECT id, profile_code, display_name, category, authorization_level, consent_status, updated_at FROM person_profiles").fetchall()]
        reviews = [dict(r) for r in conn.execute("SELECT id, title, priority, status, assigned_to, updated_at FROM watchlist_reviews").fetchall()]
        audit_count = conn.execute("SELECT COUNT(*) AS c FROM audit_logs").fetchone()["c"]
    repo.write_audit_log(
        actor="Local Administrator",
        actor_role="admin",
        action="COMPLIANCE_REPORT_GENERATED",
        resource_type="report",
        details="Generated live SQLite operational & compliance summary report.",
    )
    return {
        "generated_at": utc_now_iso(),
        "platform": "LumaFlux Intelligence",
        "stage": "Stage 2 Vision & Streaming",
        "counts": {
            "cameras": len(cameras),
            "videos": len(videos),
            "profiles": len(profiles),
            "watchlist_reviews": len(reviews),
            "audit_logs": audit_count,
        },
        "cameras": cameras,
        "videos": videos,
        "profiles": profiles,
        "reviews": reviews,
    }
