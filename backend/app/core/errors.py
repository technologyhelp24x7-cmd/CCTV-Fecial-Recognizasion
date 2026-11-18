"""Typed domain errors for consistent API responses and audit logging."""

from __future__ import annotations


class LumaFluxError(Exception):
    status_code: int = 500
    code: str = "INTERNAL_ERROR"

    def __init__(self, message: str, status_code: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code


class NotFoundError(LumaFluxError):
    status_code = 404
    code = "RESOURCE_NOT_FOUND"


class ValidationError(LumaFluxError):
    status_code = 400
    code = "VALIDATION_ERROR"


class PolicyViolationError(LumaFluxError):
    status_code = 403
    code = "PRIVACY_POLICY_VIOLATION"
