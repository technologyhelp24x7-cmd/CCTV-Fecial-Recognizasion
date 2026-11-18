"""Abstract interfaces and privacy guardrails for modular AI video analytics."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Literal

EngineStage = Literal["stage_1_foundation", "stage_2_vision", "stage_3_analytics"]
EngineStatus = Literal["ready", "pending_stage_2", "disabled_by_policy", "missing_dependency"]


@dataclass(frozen=True)
class EngineDescriptor:
    id: str
    name: str
    stage: str
    status: EngineStatus
    description: str
    privacy_guardrail: str


@dataclass
class PipelineResult:
    executed: bool
    status: str
    reason: str
    events_detected: int = 0


class BaseDetector(ABC):
    """Contract for future modular person/motion detection engines."""

    descriptor: EngineDescriptor

    @abstractmethod
    def analyze_frame(self, frame: Any, timestamp_sec: float) -> list[dict[str, Any]]:
        """Process a single decoded frame and return structured detection metadata."""


class BasePrivacyFilter(ABC):
    """Contract for automatic privacy masking before operator review or storage."""

    @abstractmethod
    def apply_mask(self, frame: Any, regions: list[tuple[int, int, int, int]]) -> Any:
        """Apply irreversible blur/redaction to sensitive regions."""
