"""AI engine registry reporting truthful Stage 2 capabilities without fake detections."""

from __future__ import annotations

from dataclasses import asdict

from ai_engine.interfaces import EngineDescriptor, PipelineResult
from video_processing.ffmpeg_probe import is_ffmpeg_available
from video_processing.opencv_reader import get_opencv_status

BIOMETRIC_IDENTIFICATION_ENABLED = False


def get_registered_engines() -> list[dict]:
    cv_status = get_opencv_status()
    ffmpeg_ok = is_ffmpeg_available()

    engines = [
        EngineDescriptor(
            id="ffmpeg-media-inspector",
            name="FFmpeg Media & Frame Inspector",
            stage="Stage 1 (Active)",
            status="ready" if ffmpeg_ok else "missing_dependency",
            description="Extracts container codec, resolution, frame rate, duration, and poster frames from imported CCTV video files.",
            privacy_guardrail="Operates strictly on local storage paths; no outbound network calls.",
        ),
        EngineDescriptor(
            id="opencv-person-detector",
            name="OpenCV HOG Person Detector",
            stage=f"Stage 2 (Vision · OpenCV {cv_status.version})" if cv_status.available else "Stage 2 (Requires opencv-python)",
            status="ready" if cv_status.available else "missing_dependency",
            description="Detects anonymized person bounding events, timestamps, and session-scoped tracks using OpenCV HOG+SVM without biometric matching.",
            privacy_guardrail="Generates anonymized spatial events only; facial recognition and cross-camera matching remain disabled.",
        ),
        EngineDescriptor(
            id="opencv-motion-detector",
            name="OpenCV MOG2 Silhouette Detector",
            stage=f"Stage 2 (Vision · OpenCV {cv_status.version})" if cv_status.available else "Stage 2 (Requires opencv-python)",
            status="ready" if cv_status.available else "missing_dependency",
            description="Detects upright moving foreground silhouettes via OpenCV MOG2 background modeling.",
            privacy_guardrail="Non-biometric contour envelopes only; no cross-camera identity linkage.",
        ),
        EngineDescriptor(
            id="privacy-redaction-filter",
            name="Privacy Masking & Blur Pipeline",
            stage="Stage 2 (Active)" if (ffmpeg_ok or cv_status.available) else "Stage 2 (Requires FFmpeg/OpenCV)",
            status="ready" if (ffmpeg_ok or cv_status.available) else "missing_dependency",
            description="Applies configurable blur or pixelation masks to detected bounding boxes or review regions during video exports.",
            privacy_guardrail="Default-on privacy masking enforced by local privacy settings.",
        ),
        EngineDescriptor(
            id="biometric-matching-guard",
            name="Biometric Identification Module",
            stage="Policy Restricted",
            status="disabled_by_policy",
            description="Biometric identification and facial recognition are intentionally disabled by LumaFlux privacy policy.",
            privacy_guardrail="Hard-disabled to enforce privacy, consent, and governance requirements.",
        ),
    ]
    return [asdict(engine) for engine in engines]


def run_stage1_safe_pipeline(engine_id: str, video_id: str) -> PipelineResult:
    """Refuse to synthesize fake detections; report truthful execution status."""
    if engine_id == "biometric-matching-guard":
        return PipelineResult(
            executed=False,
            status="denied_by_policy",
            reason="Biometric identification is disabled by LumaFlux privacy policy.",
            events_detected=0,
        )
    if engine_id == "ffmpeg-media-inspector":
        return PipelineResult(
            executed=True,
            status="completed",
            reason=f"Metadata inspection verified for video {video_id}.",
            events_detected=0,
        )
    if engine_id in ("opencv-person-detector", "opencv-motion-detector"):
        cv_status = get_opencv_status()
        if not cv_status.available:
            return PipelineResult(
                executed=False,
                status="skipped",
                reason=(
                    f"OpenCV (cv2) is not installed; cannot run '{engine_id}'. "
                    "Install opencv-python-headless to detect real person events. No fake detections generated."
                ),
                events_detected=0,
            )
        return PipelineResult(
            executed=True,
            status="ready",
            reason=f"OpenCV {cv_status.version} available for '{engine_id}'.",
            events_detected=0,
        )
    return PipelineResult(
        executed=False,
        status="skipped",
        reason=f"Engine '{engine_id}' requires Stage 2 execution parameters. No synthetic detections generated.",
        events_detected=0,
    )
