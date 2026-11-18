"""Dashboard aggregation endpoints."""

from fastapi import APIRouter, Request

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard/summary")
def get_dashboard_summary(request: Request) -> dict:
    repo = request.app.state.repo
    return repo.get_dashboard_summary()
