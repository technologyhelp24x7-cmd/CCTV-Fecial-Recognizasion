"""Person Profiles routes with consent and privacy governance."""

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/profiles", tags=["profiles"])


class ProfileCreateRequest(BaseModel):
    display_name: str
    category: str = "anonymous"
    authorization_level: str = "anonymous"
    consent_status: str = "pending"
    department_or_zone: str = "General"
    notes: str = ""
    retention_expires_at: str | None = None


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = None
    category: str | None = None
    authorization_level: str | None = None
    consent_status: str | None = None
    department_or_zone: str | None = None
    notes: str | None = None


@router.get("")
def list_profiles(request: Request) -> list[dict]:
    return request.app.state.repo.list_profiles()


@router.post("", status_code=201)
def create_profile(payload: ProfileCreateRequest, request: Request) -> dict:
    return request.app.state.repo.create_profile(payload.model_dump())


@router.patch("/{profile_id}")
def update_profile(profile_id: str, payload: ProfileUpdateRequest, request: Request) -> dict:
    return request.app.state.repo.update_profile(profile_id, payload.model_dump(exclude_none=True))


@router.delete("/{profile_id}")
def delete_profile(profile_id: str, request: Request) -> dict:
    request.app.state.repo.delete_profile(profile_id)
    return {"deleted": True, "id": profile_id}
