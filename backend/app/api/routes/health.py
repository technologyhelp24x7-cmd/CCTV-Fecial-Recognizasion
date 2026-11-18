"""Health and capability status endpoints."""

from fastapi import APIRouter, Request

from ai_engine.registry import BIOMETRIC_IDENTIFICATION_ENABLED, get_registered_engines
from backend.app.core.platform_compat import get_platform_capabilities
from video_processing.ffmpeg_probe import is_ffmpeg_available
from video_processing.opencv_reader import get_opencv_status

router = APIRouter(tags=["health"])


@router.get("/health")
def health_check(request: Request) -> dict:
    config = request.app.state.config
    cv_status = get_opencv_status()
    return {
        "status": "ok",
        "app_name": config.app_name,
        "version": config.version,
        "database_dialect": config.database_dialect,
        "ffmpeg_available": is_ffmpeg_available(),
        "opencv_available": cv_status.available,
        "opencv_version": cv_status.version,
        "biometric_identification_enabled": BIOMETRIC_IDENTIFICATION_ENABLED,
        "engines": get_registered_engines(),
    }


@router.get("/system/capabilities")
def system_capabilities(request: Request) -> dict:
    storage_dir, _ = request.app.state.repo.get_directories()
    return get_platform_capabilities(storage_dir=storage_dir)


@router.post("/system/shutdown")
def graceful_shutdown(request: Request) -> dict:
    """Stop all active streams and recordings cleanly before desktop backend exit."""
    import os
    import signal
    import threading

    mgr = getattr(request.app.state, "stream_manager", None)
    if mgr:
        mgr.shutdown_all()

    def _delayed_sigterm() -> None:
        import time

        time.sleep(0.15)
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception:
            pass

    threading.Thread(target=_delayed_sigterm, daemon=True).start()
    return {"shutting_down": True}

