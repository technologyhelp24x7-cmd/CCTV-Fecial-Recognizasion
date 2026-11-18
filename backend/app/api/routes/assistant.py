"""AI System Assistant endpoints: Chat, Diagnostics, 4-Level Actions, and Safe Extensibility Proposals."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel

from backend.app.services.ai_assistant import (
    approve_assistant_action,
    execute_assistant_action,
    handle_assistant_chat,
    list_approved_dashboard_widgets,
    list_assistant_actions,
    list_assistant_messages,
    list_extension_proposals,
    propose_extension,
    reject_assistant_action,
    rollback_assistant_action,
    run_system_diagnostics,
    transition_extension,
)

router = APIRouter(prefix="/assistant", tags=["assistant"])


class AssistantChatRequest(BaseModel):
    message: str
    language: str = "en-US"
    session_id: str = "default"


class AssistantExecuteActionRequest(BaseModel):
    action_type: str
    target_resource: str = "system"
    payload: dict[str, Any] = {}
    requested_by: str = "Local Administrator"


class ExtensionProposeRequest(BaseModel):
    prompt: str


@router.get("/messages")
def get_messages(request: Request, session_id: str = Query(default="default")) -> list[dict]:
    return list_assistant_messages(request.app.state.repo, session_id=session_id)


@router.post("/chat")
def chat(payload: AssistantChatRequest, request: Request) -> dict:
    return handle_assistant_chat(
        request.app.state.repo,
        message=payload.message,
        language=payload.language,
        session_id=payload.session_id,
    )


@router.post("/diagnostics")
def run_diagnostics(request: Request) -> dict:
    return run_system_diagnostics(request.app.state.repo)


@router.get("/actions")
def get_actions(request: Request) -> list[dict]:
    return list_assistant_actions(request.app.state.repo)


@router.post("/actions/execute")
def execute_action(payload: AssistantExecuteActionRequest, request: Request) -> dict:
    return execute_assistant_action(
        request.app.state.repo,
        action_type=payload.action_type,
        target_resource=payload.target_resource,
        payload=payload.payload,
        requested_by=payload.requested_by,
    )


@router.post("/actions/{action_id}/approve")
def approve_action(action_id: str, request: Request) -> dict:
    return approve_assistant_action(request.app.state.repo, action_id)


@router.post("/actions/{action_id}/reject")
def reject_action(action_id: str, request: Request) -> dict:
    return reject_assistant_action(request.app.state.repo, action_id)


@router.post("/actions/{action_id}/rollback")
def rollback_action(action_id: str, request: Request) -> dict:
    return rollback_assistant_action(request.app.state.repo, action_id)


@router.get("/extensions")
def get_extensions(request: Request) -> list[dict]:
    return list_extension_proposals(request.app.state.repo)


@router.post("/extensions/propose", status_code=201)
def propose_ext(payload: ExtensionProposeRequest, request: Request) -> dict:
    return propose_extension(request.app.state.repo, payload.prompt)


@router.post("/extensions/{proposal_id}/approve")
def approve_ext(proposal_id: str, request: Request) -> dict:
    return transition_extension(request.app.state.repo, proposal_id, "approved")


@router.post("/extensions/{proposal_id}/reject")
def reject_ext(proposal_id: str, request: Request) -> dict:
    return transition_extension(request.app.state.repo, proposal_id, "rejected")


@router.post("/extensions/{proposal_id}/rollback")
def rollback_ext(proposal_id: str, request: Request) -> dict:
    return transition_extension(request.app.state.repo, proposal_id, "rolled_back")


@router.get("/active-widgets")
def active_widgets(request: Request) -> list[dict]:
    return list_approved_dashboard_widgets(request.app.state.repo)
