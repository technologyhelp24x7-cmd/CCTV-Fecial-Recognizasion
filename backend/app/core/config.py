"""Application configuration with configurable local storage and SQLite/PostgreSQL support."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AppConfig:
    app_name: str
    version: str
    env: str
    host: str
    port: int
    root_dir: Path
    db_path: Path
    database_url: str
    storage_dir: Path
    thumbnail_dir: Path
    log_dir: Path
    log_level: str
    api_token: str = ""

    @property
    def database_dialect(self) -> str:
        if self.database_url.startswith("postgres"):
            return "postgresql"
        return "sqlite"


def load_config() -> AppConfig:
    root_dir = Path(__file__).resolve().parents[3]
    default_storage_root = root_dir / "storage"

    db_path = Path(os.getenv("LUMAFLUX_DB_PATH", str(default_storage_root / "lumaflux.db"))).resolve()
    database_url = os.getenv("LUMAFLUX_DATABASE_URL", "").strip()
    if not database_url:
        database_url = f"sqlite:///{db_path}"

    storage_dir = Path(os.getenv("LUMAFLUX_STORAGE_DIR", str(default_storage_root / "videos"))).resolve()
    thumbnail_dir = Path(os.getenv("LUMAFLUX_THUMBNAIL_DIR", str(default_storage_root / "thumbnails"))).resolve()
    log_dir = Path(os.getenv("LUMAFLUX_LOG_DIR", str(default_storage_root / "logs"))).resolve()

    return AppConfig(
        app_name="LumaFlux Intelligence",
        version="0.1.0",
        env=os.getenv("LUMAFLUX_ENV", "development"),
        host=os.getenv("LUMAFLUX_BACKEND_HOST", "127.0.0.1"),
        port=int(os.getenv("LUMAFLUX_BACKEND_PORT", "8420")),
        root_dir=root_dir,
        db_path=db_path,
        database_url=database_url,
        storage_dir=storage_dir,
        thumbnail_dir=thumbnail_dir,
        log_dir=log_dir,
        log_level=os.getenv("LUMAFLUX_LOG_LEVEL", "INFO").upper(),
        api_token=os.getenv("LUMAFLUX_API_TOKEN", "").strip(),
    )


def ensure_storage_directories(config: AppConfig) -> None:
    config.db_path.parent.mkdir(parents=True, exist_ok=True)
    config.storage_dir.mkdir(parents=True, exist_ok=True)
    config.thumbnail_dir.mkdir(parents=True, exist_ok=True)
    config.log_dir.mkdir(parents=True, exist_ok=True)
