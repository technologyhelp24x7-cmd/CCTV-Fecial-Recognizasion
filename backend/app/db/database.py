"""Database initialization, Stage 2 migrations, and connection management (SQLite + PostgreSQL-ready)."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from backend.app.core.config import AppConfig


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


_STAGE2_COLUMN_MIGRATIONS: list[tuple[str, str, str]] = [
    ("cameras", "last_error", "TEXT"),
    ("cameras", "reconnect_attempts", "INTEGER NOT NULL DEFAULT 0"),
    ("cameras", "max_reconnect_attempts", "INTEGER NOT NULL DEFAULT 5"),
    ("cameras", "target_fps", "REAL NOT NULL DEFAULT 5.0"),
    ("cameras", "target_resolution", "TEXT NOT NULL DEFAULT '1280x720'"),
    ("cameras", "recording_schedule", "TEXT"),
    ("video_files", "recording_session_id", "TEXT"),
    ("video_files", "source_origin", "TEXT NOT NULL DEFAULT 'imported'"),
    ("video_files", "expires_at", "TEXT"),
    ("person_events", "anonymous_track_id", "TEXT REFERENCES anonymous_tracks(id) ON DELETE SET NULL"),
    ("person_events", "end_timestamp_sec", "REAL"),
    ("person_events", "frame_count", "INTEGER NOT NULL DEFAULT 1"),
    ("person_events", "bbox_json", "TEXT"),
    ("person_events", "model_name", "TEXT"),
    ("person_events", "reviewed_by", "TEXT"),
    ("person_events", "reviewed_at", "TEXT"),
    # Stage 3 structured camera, ONVIF, NVR & stream metrics columns
    ("cameras", "ip_address", "TEXT"),
    ("cameras", "rtsp_port", "INTEGER NOT NULL DEFAULT 554"),
    ("cameras", "onvif_port", "INTEGER NOT NULL DEFAULT 80"),
    ("cameras", "username", "TEXT"),
    ("cameras", "credential_ref", "TEXT"),
    ("cameras", "rtsp_transport", "TEXT NOT NULL DEFAULT 'tcp'"),
    ("cameras", "stream_profile", "TEXT NOT NULL DEFAULT 'main'"),
    ("cameras", "main_stream_uri", "TEXT"),
    ("cameras", "sub_stream_uri", "TEXT"),
    ("cameras", "connection_timeout_sec", "REAL NOT NULL DEFAULT 6.0"),
    ("cameras", "nvr_id", "TEXT"),
    ("cameras", "channel_number", "INTEGER"),
    ("cameras", "device_manufacturer", "TEXT"),
    ("cameras", "device_model", "TEXT"),
    ("cameras", "firmware_version", "TEXT"),
    ("cameras", "vendor_driver", "TEXT NOT NULL DEFAULT 'standard_onvif'"),
    ("cameras", "capabilities_json", "TEXT"),
    ("cameras", "verification_stages_json", "TEXT"),
    ("person_events", "notes", "TEXT NOT NULL DEFAULT ''"),
    ("camera_stream_sessions", "frames_dropped", "INTEGER NOT NULL DEFAULT 0"),
    ("camera_stream_sessions", "bytes_received", "INTEGER NOT NULL DEFAULT 0"),
    ("camera_stream_sessions", "avg_frame_ms", "REAL"),
]


class DatabaseManager:
    """Manages SQLite connections, schema migrations, and default local settings."""

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.schema_path = config.root_dir / "database" / "schema.sql"

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.config.db_path), timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self) -> None:
        if self.config.database_dialect != "sqlite":
            raise NotImplementedError(
                "PostgreSQL driver hook is configured for future stages; Stage 2 local runtime uses SQLite."
            )

        self.config.db_path.parent.mkdir(parents=True, exist_ok=True)
        schema_sql = self.schema_path.read_text(encoding="utf-8")
        with self.connection() as conn:
            self._apply_column_migrations(conn)
            conn.executescript(schema_sql)
            self._seed_default_settings(conn)

    def _apply_column_migrations(self, conn: sqlite3.Connection) -> None:
        """Add Stage 2 columns to pre-existing Stage 1 tables before applying new indexes."""
        existing_tables = {
            row["name"]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        for table, column, col_def in _STAGE2_COLUMN_MIGRATIONS:
            if table not in existing_tables:
                continue
            cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if column not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}")

    def _seed_default_settings(self, conn: sqlite3.Connection) -> None:
        now = utc_now_iso()
        defaults = [
            (
                "storage_directory",
                str(self.config.storage_dir),
                "storage",
                "Local root directory for imported and recorded CCTV video assets",
            ),
            (
                "thumbnail_directory",
                str(self.config.thumbnail_dir),
                "storage",
                "Local directory for extracted video poster frames and event thumbnails",
            ),
            (
                "max_storage_quota_gb",
                "250",
                "storage",
                "Maximum soft storage allocation quota in gigabytes",
            ),
            (
                "default_retention_days",
                "30",
                "privacy",
                "Default retention period for imported/recorded video footage and anonymous events",
            ),
            (
                "privacy_blur_default",
                "true",
                "privacy",
                "Mask unidentified subjects by default during video preview, thumbnails, and exports",
            ),
            (
                "privacy_mask_mode",
                "blur",
                "privacy",
                "Privacy masking filter style (blur or pixelate)",
            ),
            (
                "detection_confidence_threshold",
                "0.45",
                "ai",
                "Minimum confidence score for OpenCV person detection events",
            ),
            (
                "detection_sample_fps",
                "2.0",
                "ai",
                "Target frames per second sampled during video person detection",
            ),
            (
                "require_consent_for_profiles",
                "true",
                "privacy",
                "Require explicit consent verification before marking registered profiles authorized",
            ),
            (
                "log_level",
                self.config.log_level,
                "system",
                "Backend structured logging verbosity level",
            ),
            (
                "theme",
                "dark",
                "appearance",
                "Default workspace interface theme (dark or light)",
            ),
            (
                "database_engine",
                "SQLite 3 (PostgreSQL migration ready)",
                "system",
                "Active local metadata database engine",
            ),
            (
                "max_concurrent_streams",
                "8",
                "cameras",
                "Maximum simultaneous live camera MJPEG workers allowed",
            ),
            (
                "max_concurrent_recordings",
                "8",
                "cameras",
                "Maximum simultaneous MP4 camera recording workers allowed",
            ),
        ]
        for key, value, category, description in defaults:
            conn.execute(
                """
                INSERT OR IGNORE INTO app_settings (key, value, category, description, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (key, value, category, description, now),
            )
