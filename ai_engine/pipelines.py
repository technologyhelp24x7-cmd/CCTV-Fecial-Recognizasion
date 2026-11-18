"""Pipeline orchestration entry point for Stage 1 & Stage 2 AI and privacy jobs."""

from ai_engine.interfaces import PipelineResult
from ai_engine.person_detector import DetectionRunResult, detect_persons_in_video
from ai_engine.privacy_filter import export_privacy_masked_video
from ai_engine.registry import run_stage1_safe_pipeline

__all__ = [
    "DetectionRunResult",
    "PipelineResult",
    "detect_persons_in_video",
    "export_privacy_masked_video",
    "run_stage1_safe_pipeline",
]
