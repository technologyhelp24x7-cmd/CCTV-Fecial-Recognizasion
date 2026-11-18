"""Security & Audit Logs routes."""

from fastapi import APIRouter, Query, Request

router = APIRouter(prefix="/audit-logs", tags=["audit"])


@router.get("")
def list_audit_logs(request: Request, limit: int = Query(default=100, ge=1, le=500)) -> list[dict]:
    return request.app.state.repo.list_audit_logs(limit=limit)
