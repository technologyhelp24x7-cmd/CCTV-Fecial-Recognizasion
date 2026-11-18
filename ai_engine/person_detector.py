"""Stage 2 Phase C: Modular OpenCV-based person detection engine (zero synthetic detections).

Supported engines:
- opencv-person-detector: OpenCV HOG + linear SVM pedestrian detector (`HOGDescriptor_getDefaultPeopleDetector`).
- opencv-motion-detector: OpenCV MOG2 foreground silhouette candidate detector.

Truthfulness rule:
If `cv2` is unavailable, no detections are fabricated; the runner returns `status='missing_dependency'`.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Optional

from ai_engine.interfaces import BaseDetector, EngineDescriptor
from ai_engine.tracker import AnonymousSessionTracker, RawDetection, compute_iou, extract_event_crop
from video_processing.opencv_reader import get_opencv_status


@dataclass
class DetectionRunResult:
    executed: bool
    status: str  # completed | missing_dependency | failed
    engine_id: str
    reason: str
    frames_analyzed: int = 0
    raw_detections_count: int = 0
    tracks: list[dict[str, Any]] = None  # type: ignore[assignment]
    events: list[dict[str, Any]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.tracks is None:
            self.tracks = []
        if self.events is None:
            self.events = []


def apply_nms(detections: list[RawDetection], iou_threshold: float = 0.45) -> list[RawDetection]:
    """Suppress overlapping bounding boxes produced on the same frame."""
    if len(detections) <= 1:
        return detections
    ordered = sorted(detections, key=lambda d: d.confidence, reverse=True)
    kept: list[RawDetection] = []
    for candidate in ordered:
        if all(compute_iou(candidate.bbox, k.bbox) < iou_threshold for k in kept):
            kept.append(candidate)
    return kept


class OpenCVHogPersonDetector(BaseDetector):
    """OpenCV HOGDescriptor default people detector with sigmoid confidence calibration."""

    descriptor = EngineDescriptor(
        id="opencv-person-detector",
        name="OpenCV HOG Person Detector",
        stage="Stage 2 (Computer Vision)",
        status="ready",
        description="Detects anonymized upright person bounding boxes and confidence scores using OpenCV HOG+SVM.",
        privacy_guardrail="Spatial bounding boxes only; facial recognition and biometric matching remain disabled.",
    )

    def __init__(self, confidence_threshold: float = 0.45) -> None:
        self.confidence_threshold = min(max(confidence_threshold, 0.05), 0.99)
        self._hog: Any = None
        cv_status = get_opencv_status()
        if cv_status.available:
            import cv2  # type: ignore[import-not-found]

            if hasattr(cv2, "HOGDescriptor") and hasattr(cv2, "HOGDescriptor_getDefaultPeopleDetector"):
                hog = cv2.HOGDescriptor()
                hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
                self._hog = hog

    def analyze_frame(self, frame: Any, timestamp_sec: float, frame_number: int = 0) -> list[dict[str, Any]]:
        if self._hog is None or frame is None:
            return []
        rects, weights = self._hog.detectMultiScale(
            frame,
            winStride=(8, 8),
            padding=(8, 8),
            scale=1.05,
        )
        raw: list[RawDetection] = []
        for (x, y, w, h), weight in zip(rects, weights):
            score_val = float(weight[0]) if hasattr(weight, "__len__") else float(weight)
            conf = round(1.0 / (1.0 + math.exp(-score_val)), 4)
            if conf >= self.confidence_threshold:
                raw.append(
                    RawDetection(
                        timestamp_sec=round(timestamp_sec, 3),
                        frame_number=frame_number,
                        confidence=conf,
                        bbox={"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
                        model_name="opencv-hog-svm",
                    )
                )
        kept = apply_nms(raw)
        return [asdict(d) for d in kept]


class OpenCVMotionPersonDetector(BaseDetector):
    """OpenCV MOG2 background subtractor filtering upright human-proportioned foreground contours."""

    descriptor = EngineDescriptor(
        id="opencv-motion-detector",
        name="OpenCV MOG2 Silhouette Detector",
        stage="Stage 2 (Computer Vision)",
        status="ready",
        description="Detects moving upright foreground regions via OpenCV MOG2 background modeling.",
        privacy_guardrail="Non-biometric contour motion envelopes only; strictly camera-local.",
    )

    def __init__(self, confidence_threshold: float = 0.45, min_area: int = 1200) -> None:
        self.confidence_threshold = min(max(confidence_threshold, 0.05), 0.99)
        self.min_area = min_area
        self._subtractor: Any = None
        cv_status = get_opencv_status()
        if cv_status.available:
            import cv2  # type: ignore[import-not-found]

            self._subtractor = cv2.createBackgroundSubtractorMOG2(history=120, varThreshold=36, detectShadows=False)

    def analyze_frame(self, frame: Any, timestamp_sec: float, frame_number: int = 0) -> list[dict[str, Any]]:
        if self._subtractor is None or frame is None:
            return []
        import cv2  # type: ignore[import-not-found]

        fg_mask = self._subtractor.apply(frame)
        contours, _ = cv2.findContours(fg_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        raw: list[RawDetection] = []
        for cnt in contours:
            x, y, w, h = cv2.boundingRect(cnt)
            area = w * h
            if area < self.min_area or h <= 0:
                continue
            aspect = h / float(max(w, 1))
            if aspect < 1.1:
                continue
            conf = round(min(0.95, 0.45 + (area / 25000.0) * 0.5), 4)
            if conf >= self.confidence_threshold:
                raw.append(
                    RawDetection(
                        timestamp_sec=round(timestamp_sec, 3),
                        frame_number=frame_number,
                        confidence=conf,
                        bbox={"x": int(x), "y": int(y), "w": int(w), "h": int(h)},
                        model_name="opencv-mog2-motion",
                    )
                )
        return [asdict(d) for d in apply_nms(raw)]


def build_detector(engine_id: str, confidence_threshold: float = 0.45) -> BaseDetector:
    if engine_id == "opencv-motion-detector":
        return OpenCVMotionPersonDetector(confidence_threshold=confidence_threshold)
    return OpenCVHogPersonDetector(confidence_threshold=confidence_threshold)


def detect_persons_in_video(
    video_path: Path,
    video_file_id: str,
    camera_id: Optional[str] = None,
    engine_id: str = "opencv-person-detector",
    sample_fps: float = 2.0,
    confidence_threshold: float = 0.45,
    crop_dir: Optional[Path] = None,
    apply_privacy_blur: bool = True,
    max_frames: int = 600,
) -> DetectionRunResult:
    """Run real OpenCV person detection + session tracking across a local video asset."""
    cv_status = get_opencv_status()
    if not cv_status.available:
        return DetectionRunResult(
            executed=False,
            status="missing_dependency",
            engine_id=engine_id,
            reason=(
                "OpenCV (cv2) is not installed in the active Python environment. "
                "Install opencv-python-headless to execute real person detection. "
                "No synthetic detections were generated."
            ),
        )

    if not video_path.exists():
        return DetectionRunResult(
            executed=False,
            status="failed",
            engine_id=engine_id,
            reason=f"Target video file not found at '{video_path}'.",
        )

    import cv2  # type: ignore[import-not-found]

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return DetectionRunResult(
            executed=False,
            status="failed",
            engine_id=engine_id,
            reason=f"OpenCV VideoCapture failed to open '{video_path.name}'.",
        )

    detector = build_detector(engine_id, confidence_threshold=confidence_threshold)
    if engine_id == "opencv-person-detector" and getattr(detector, "_hog", None) is None:
        cap.release()
        return DetectionRunResult(
            executed=False,
            status="missing_dependency",
            engine_id=engine_id,
            reason=f"Installed OpenCV ({cv_status.version}) build does not expose cv2.HOGDescriptor. Install opencv-python-headless<5.0.",
        )
    native_fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
    if native_fps <= 0 or native_fps > 120:
        native_fps = 25.0
    step = max(1, int(round(native_fps / max(0.25, sample_fps))))

    raw_detections: list[RawDetection] = []
    frames_analyzed = 0
    frame_idx = 0

    try:
        while frames_analyzed < max_frames:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            if frame_idx % step == 0:
                timestamp_sec = frame_idx / native_fps
                hits = detector.analyze_frame(frame, timestamp_sec, frame_number=frame_idx)  # type: ignore[call-arg]
                for h in hits:
                    raw_detections.append(
                        RawDetection(
                            timestamp_sec=float(h["timestamp_sec"]),
                            frame_number=int(h["frame_number"]),
                            confidence=float(h["confidence"]),
                            bbox=dict(h["bbox"]),
                            model_name=str(h["model_name"]),
                        )
                    )
                frames_analyzed += 1
            frame_idx += 1
    finally:
        cap.release()

    tracker = AnonymousSessionTracker(camera_id=camera_id, video_file_id=video_file_id)
    tracks, events = tracker.process_detections(raw_detections)

    if crop_dir:
        for evt in events:
            out = crop_dir / f"{evt.event_id}.jpg"
            saved = extract_event_crop(
                video_path=video_path,
                output_path=out,
                timestamp_sec=evt.best_timestamp_sec,
                bbox=evt.best_bbox,
                apply_privacy_blur=apply_privacy_blur,
            )
            if saved:
                evt.crop_path = str(saved)

    return DetectionRunResult(
        executed=True,
        status="completed",
        engine_id=engine_id,
        reason=(
            f"Analyzed {frames_analyzed} sampled frames ({sample_fps:.1f} fps, threshold={confidence_threshold:.2f}); "
            f"recorded {len(events)} grouped person event(s) across {len(tracks)} anonymous track(s)."
        ),
        frames_analyzed=frames_analyzed,
        raw_detections_count=len(raw_detections),
        tracks=[
            {
                "track_id": t.track_id,
                "track_code": t.track_code,
                "camera_id": t.camera_id,
                "video_file_id": t.video_file_id,
                "first_seen_sec": t.first_seen_sec,
                "last_seen_sec": t.last_seen_sec,
                "event_count": len(t.events),
                "best_confidence": t.best_confidence,
            }
            for t in tracks
        ],
        events=[asdict(e) for e in events],
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="LumaFlux Stage 2 OpenCV Person Detector CLI")
    parser.add_argument("--video", required=True)
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--camera-id", default="")
    parser.add_argument("--engine", default="opencv-person-detector")
    parser.add_argument("--fps", type=float, default=2.0)
    parser.add_argument("--threshold", type=float, default=0.45)
    parser.add_argument("--crop-dir", default="")
    parser.add_argument("--privacy-blur", default="true")
    args = parser.parse_args()

    res = detect_persons_in_video(
        video_path=Path(args.video),
        video_file_id=args.video_id,
        camera_id=args.camera_id or None,
        engine_id=args.engine,
        sample_fps=args.fps,
        confidence_threshold=args.threshold,
        crop_dir=Path(args.crop_dir) if args.crop_dir else None,
        apply_privacy_blur=args.privacy_blur.lower() == "true",
    )
    print(json.dumps(asdict(res)))


if __name__ == "__main__":
    main()
