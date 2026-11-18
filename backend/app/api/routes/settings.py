"""Application settings routes."""

from fastapi import APIRouter, Request

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
def get_settings(request: Request) -> dict:
    return request.app.state.repo.get_settings()


@router.put("")
def update_settings(payload: dict[str, str], request: Request) -> dict:
    return request.app.state.repo.update_settings(payload)
