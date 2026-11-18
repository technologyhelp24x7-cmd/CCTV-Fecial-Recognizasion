"""Stage 2 Phase D: Session- and camera-scoped anonymous person tracking and event grouping.

Strict privacy guarantees:
- Tracks are scoped strictly to a single camera/video processing session.
- Cross-camera unknown-person linking is intentionally NOT implemented.
- No facial recognition, biometric embeddings, or persistent identity vectors are computed.
"""

from __future__ import annotations

import math
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from video_processing.ffmpeg_probe import is_ffmpeg_available


@dataclass(frozen=True)
class RawDetection:
    timestamp_sec: float
    frame_number: int
    confidence: float
    bbox: dict[str, int]  # {"x": int, "y": int, "w": int, "h": int}
    model_name: str


@dataclass
class GroupedPersonEvent:
    event_id: str
    track_id: str
    track_code: str
    camera_id: Optional[str]
    video_file_id: str
    start_timestamp_sec: float
    end_timestamp_sec: float
    best_timestamp_sec: float
    peak_confidence: float
    best_frame_number: int
    frame_count: int
    best_bbox: dict[str, int]
    model_name: str
    crop_path: Optional[str] = None


@dataclass
class AnonymousTrackState:
    track_id: str
    track_code: str
    camera_id: Optional[str]
    video_file_id: str
    first_seen_sec: float
    last_seen_sec: float
    best_confidence: float
    last_bbox: dict[str, int]
    events: list[GroupedPersonEvent] = field(default_factory=list)


def compute_iou(box_a: dict[str, int], box_b: dict[str, int]) -> float:
    ax1, ay1 = box_a["x"], box_a["y"]
    ax2, ay2 = ax1 + max(0, box_a["w"]), ay1 + max(0, box_a["h"])
    bx1, by1 = box_b["x"], box_b["y"]
    bx2, by2 = bx1 + max(0, box_b["w"]), by1 + max(0, box_b["h"])

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1)
    ih = max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def compute_centroid_distance(box_a: dict[str, int], box_b: dict[str, int]) -> float:
    acx = box_a["x"] + box_a["w"] / 2.0
    acy = box_a["y"] + box_a["h"] / 2.0
    bcx = box_b["x"] + box_b["w"] / 2.0
    bcy = box_b["y"] + box_b["h"] / 2.0
    return math.hypot(acx - bcx, acy - bcy)


class AnonymousSessionTracker:
    """Assigns session-scoped temporary TRK-* IDs and deduplicates consecutive frame hits into events."""

    def __init__(
        self,
        camera_id: Optional[str],
        video_file_id: str,
        iou_threshold: float = 0.20,
        max_gap_sec: float = 2.5,
        max_centroid_dist_px: float = 160.0,
    ) -> None:
        self.camera_id = camera_id
        self.video_file_id = video_file_id
        self.iou_threshold = iou_threshold
        self.max_gap_sec = max_gap_sec
        self.max_centroid_dist_px = max_centroid_dist_px
        self._seq = 0
        self._tracks: list[AnonymousTrackState] = []

    def _next_track_code(self) -> str:
        self._seq += 1
        prefix = (self.camera_id[:4].upper() if self.camera_id else "VOD")
        return f"TRK-{prefix}-{self._seq:04d}"

    def process_detections(
        self, detections: list[RawDetection]
    ) -> tuple[list[AnonymousTrackState], list[GroupedPersonEvent]]:
        ordered = sorted(detections, key=lambda d: (d.timestamp_sec, d.frame_number))

        for det in ordered:
            best_track: Optional[AnonymousTrackState] = None
            best_score = -1.0

            for trk in self._tracks:
                if trk.camera_id != self.camera_id or trk.video_file_id != self.video_file_id:
                    continue
                gap = det.timestamp_sec - trk.last_seen_sec
                if gap < 0 or gap > self.max_gap_sec:
                    continue
                iou = compute_iou(trk.last_bbox, det.bbox)
                dist = compute_centroid_distance(trk.last_bbox, det.bbox)
                if iou >= self.iou_threshold or dist <= self.max_centroid_dist_px:
                    score = iou * 2.0 + max(0.0, 1.0 - dist / max(1.0, self.max_centroid_dist_px))
                    if score > best_score:
                        best_score = score
                        best_track = trk

            if best_track is None:
                trk_id = str(uuid.uuid4())
                trk_code = self._next_track_code()
                evt = GroupedPersonEvent(
                    event_id=str(uuid.uuid4()),
                    track_id=trk_id,
                    track_code=trk_code,
                    camera_id=self.camera_id,
                    video_file_id=self.video_file_id,
                    start_timestamp_sec=det.timestamp_sec,
                    end_timestamp_sec=det.timestamp_sec,
                    best_timestamp_sec=det.timestamp_sec,
                    peak_confidence=det.confidence,
                    best_frame_number=det.frame_number,
                    frame_count=1,
                    best_bbox=dict(det.bbox),
                    model_name=det.model_name,
                )
                trk = AnonymousTrackState(
                    track_id=trk_id,
                    track_code=trk_code,
                    camera_id=self.camera_id,
                    video_file_id=self.video_file_id,
                    first_seen_sec=det.timestamp_sec,
                    last_seen_sec=det.timestamp_sec,
                    best_confidence=det.confidence,
                    last_bbox=dict(det.bbox),
                    events=[evt],
                )
                self._tracks.append(trk)
            else:
                best_track.last_seen_sec = det.timestamp_sec
                best_track.last_bbox = dict(det.bbox)
                if det.confidence > best_track.best_confidence:
                    best_track.best_confidence = det.confidence

                last_evt = best_track.events[-1]
                # Merge consecutive frame hits within max_gap_sec into the same grouped person event
                if (det.timestamp_sec - last_evt.end_timestamp_sec) <= self.max_gap_sec:
                    last_evt.end_timestamp_sec = det.timestamp_sec
                    last_evt.frame_count += 1
                    if det.confidence >= last_evt.peak_confidence:
                        last_evt.peak_confidence = det.confidence
                        last_evt.best_timestamp_sec = det.timestamp_sec
                        last_evt.best_frame_number = det.frame_number
                        last_evt.best_bbox = dict(det.bbox)
                else:
                    best_track.events.append(
                        GroupedPersonEvent(
                            event_id=str(uuid.uuid4()),
                            track_id=best_track.track_id,
                            track_code=best_track.track_code,
                            camera_id=self.camera_id,
                            video_file_id=self.video_file_id,
                            start_timestamp_sec=det.timestamp_sec,
                            end_timestamp_sec=det.timestamp_sec,
                            best_timestamp_sec=det.timestamp_sec,
                            peak_confidence=det.confidence,
                            best_frame_number=det.frame_number,
                            frame_count=1,
                            best_bbox=dict(det.bbox),
                            model_name=det.model_name,
                        )
                    )

        all_events = [evt for trk in self._tracks for evt in trk.events]
        return self._tracks, all_events


def extract_event_crop(
    video_path: Path,
    output_path: Path,
    timestamp_sec: float,
    bbox: dict[str, int],
    apply_privacy_blur: bool = True,
) -> Optional[Path]:
    """Extract a cropped event thumbnail at timestamp_sec using FFmpeg (with optional upper-region blur)."""
    if not is_ffmpeg_available() or not video_path.exists():
        return None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    x = max(0, int(bbox.get("x", 0)))
    y = max(0, int(bbox.get("y", 0)))
    w = max(32, int(bbox.get("w", 120)))
    h = max(32, int(bbox.get("h", 160)))

    vf = f"crop='min({w},iw-{x})':'min({h},ih-{y})':{x}:{y},scale=240:-2"
    if apply_privacy_blur:
        vf += ",boxblur=6:2"

    proc = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{max(0.0, timestamp_sec):.3f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-vf",
            vf,
            "-q:v",
            "4",
            str(output_path),
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0:
        return output_path
    return None
