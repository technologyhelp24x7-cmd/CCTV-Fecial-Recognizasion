"""Vendor-neutral NVR management, authentication probe, channel discovery, and camera registration endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/nvrs", tags=["nvrs"])


class NvrCreateRequest(BaseModel):
    name: str
    adapter_type: str = "standard_onvif_rtsp"
    host: str
    port: int = 80
    rtsp_port: int = 554
    username: str | None = None
    password: str | None = None
    rtsp_transport: str = "tcp"
    rtsp_url_template: str | None = None
    channel_count: int = 0


class NvrChannelRegisterRequest(BaseModel):
    location_zone: str | None = None


class NvrChannelUpdateRequest(BaseModel):
    enabled: bool = True


class NvrChannelCreateRequest(BaseModel):
    channel_number: int
    name: str
    main_stream_uri: str
    sub_stream_uri: str | None = None
    enabled: bool = True


@router.get("")
def list_nvrs(request: Request) -> list[dict]:
    return request.app.state.repo.list_nvrs()


@router.post("", status_code=201)
def create_nvr(payload: NvrCreateRequest, request: Request) -> dict:
    return request.app.state.repo.create_nvr(payload.model_dump())


@router.delete("/{nvr_id}")
def delete_nvr(nvr_id: str, request: Request) -> dict:
    request.app.state.repo.delete_nvr(nvr_id)
    return {"deleted": True, "id": nvr_id}


@router.post("/{nvr_id}/test")
def test_nvr(nvr_id: str, request: Request) -> dict:
    return request.app.state.repo.test_nvr(nvr_id)


@router.post("/{nvr_id}/discover-channels")
def discover_nvr_channels(nvr_id: str, request: Request) -> dict:
    return request.app.state.repo.discover_nvr_channels(nvr_id)


@router.get("/{nvr_id}/channels")
def list_nvr_channels(nvr_id: str, request: Request) -> list[dict]:
    return request.app.state.repo.list_nvr_channels(nvr_id)


@router.post("/{nvr_id}/channels", status_code=201)
def create_nvr_channel(nvr_id: str, payload: NvrChannelCreateRequest, request: Request) -> dict:
    return request.app.state.repo.create_manual_nvr_channel(nvr_id, payload.model_dump())


@router.post("/{nvr_id}/channels/{channel_id}/test")
def test_nvr_channel(nvr_id: str, channel_id: str, request: Request) -> dict:
    return request.app.state.repo.test_nvr_channel(nvr_id, channel_id)


@router.patch("/{nvr_id}/channels/{channel_id}")
def update_nvr_channel(nvr_id: str, channel_id: str, payload: NvrChannelUpdateRequest, request: Request) -> dict:
    return request.app.state.repo.update_nvr_channel(nvr_id, channel_id, payload.enabled)


@router.post("/{nvr_id}/channels/{channel_id}/register", status_code=201)
def register_nvr_channel(
    nvr_id: str,
    channel_id: str,
    request: Request,
    payload: NvrChannelRegisterRequest | None = None,
) -> dict:
    return request.app.state.repo.register_nvr_channel_as_camera(
        nvr_id,
        channel_id,
        location_zone=payload.location_zone if payload else None,
    )
