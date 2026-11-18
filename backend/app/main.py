"""LumaFlux Intelligence FastAPI Application Entry Point."""

from __future__ import annotations

import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.api.routes import (
    assistant,
    audit,
    cameras,
    dashboard,
    health,
    modules,
    nvrs,
    profiles,
    settings,
    videos,
)
from backend.app.core.config import ensure_storage_directories, load_config
from backend.app.core.errors import LumaFluxError
from backend.app.core.logging import configure_logging
from backend.app.db.database import DatabaseManager
from backend.app.db.repositories import LumaFluxRepository
from video_processing.stream_worker import StreamAndRecordingManager


def is_request_authorized(expected_token: str, auth_header: str | None, query_token: str | None) -> bool:
    """Validate optional per-session IPC bearer token using constant-time comparison."""
    if not expected_token:
        return True
    candidate = ""
    if auth_header and auth_header.lower().startswith("bearer "):
        candidate = auth_header[7:].strip()
    elif query_token:
        candidate = query_token.strip()
    if not candidate:
        return False
    return hmac.compare_digest(expected_token, candidate)


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = load_config()
    ensure_storage_directories(config)
    logger = configure_logging(config.log_dir, config.log_level)

    db = DatabaseManager(config)
    db.initialize()
    repo = LumaFluxRepository(db)
    stream_manager = StreamAndRecordingManager()

    app.state.config = config
    app.state.logger = logger
    app.state.db = db
    app.state.repo = repo
    app.state.stream_manager = stream_manager

    logger.info("LumaFlux Intelligence backend initialized (dialect=%s)", config.database_dialect)
    repo.write_audit_log(
        actor="System",
        actor_role="system",
        action="BACKEND_STARTED",
        resource_type="system",
        details=f"FastAPI backend started on {config.host}:{config.port}",
    )

    try:
        yield
    finally:
        stream_manager.shutdown_all()
        logger.info("LumaFlux Intelligence backend shutting down cleanly")


def create_app() -> FastAPI:
    app = FastAPI(
        title="LumaFlux Intelligence API",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def local_ipc_auth_middleware(request: Request, call_next):
        if request.method != "OPTIONS" and request.url.path.startswith("/api/") and request.url.path != "/api/health":
            config = getattr(request.app.state, "config", None)
            expected = config.api_token if config else ""
            if expected and not is_request_authorized(
                expected,
                request.headers.get("authorization"),
                request.query_params.get("token"),
            ):
                repo = getattr(request.app.state, "repo", None)
                if repo:
                    repo.write_audit_log(
                        actor="Unknown Local Caller",
                        actor_role="unauthenticated",
                        action="UNAUTHORIZED_API_ACCESS",
                        resource_type="api",
                        details=f"Rejected unauthorized request to {request.url.path}",
                        outcome="denied",
                    )
                return JSONResponse(
                    status_code=401,
                    content={"error": "UNAUTHORIZED", "message": "Missing or invalid desktop IPC token."},
                )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(LumaFluxError)
    async def lumaflux_exception_handler(_: Request, exc: LumaFluxError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.code, "message": exc.message},
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logger = getattr(request.app.state, "logger", None)
        if logger:
            logger.exception("Unhandled error on %s", request.url.path)
        return JSONResponse(
            status_code=500,
            content={"error": "INTERNAL_ERROR", "message": "An unexpected internal error occurred."},
        )

    app.include_router(health.router, prefix="/api")
    app.include_router(dashboard.router, prefix="/api")
    app.include_router(videos.router, prefix="/api")
    app.include_router(cameras.router, prefix="/api")
    app.include_router(cameras.driver_router, prefix="/api")
    app.include_router(nvrs.router, prefix="/api")
    app.include_router(profiles.router, prefix="/api")
    app.include_router(audit.router, prefix="/api")
    app.include_router(settings.router, prefix="/api")
    app.include_router(modules.router, prefix="/api")
    app.include_router(assistant.router, prefix="/api")

    return app


app = create_app()
