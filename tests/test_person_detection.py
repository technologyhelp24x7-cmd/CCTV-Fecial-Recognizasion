"""Stage 2 Phase C unit tests: modular OpenCV person detection, NMS, and truthful missing-dependency handling."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from ai_engine.person_detector import apply_nms, detect_persons_in_video
from ai_engine.registry import get_registered_engines, run_stage1_safe_pipeline
from ai_engine.tracker import RawDetection
from video_processing.opencv_reader import get_opencv_status


class TestPersonDetection(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.clip = self.base / "sample.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10:duration=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                str(self.clip),
            ],
            capture_output=True,
            check=True,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_nms_suppresses_overlapping_detections(self) -> None:
        dets = [
            RawDetection(timestamp_sec=1.0, frame_number=10, confidence=0.88, bbox={"x": 50, "y": 40, "w": 60, "h": 140}, model_name="hog"),
            RawDetection(timestamp_sec=1.0, frame_number=10, confidence=0.61, bbox={"x": 55, "y": 44, "w": 58, "h": 138}, model_name="hog"),
            RawDetection(timestamp_sec=1.0, frame_number=10, confidence=0.79, bbox={"x": 200, "y": 40, "w": 60, "h": 140}, model_name="hog"),
        ]
        kept = apply_nms(dets, iou_threshold=0.45)
        self.assertEqual(len(kept), 2)
        self.assertAlmostEqual(kept[0].confidence, 0.88)
        self.assertAlmostEqual(kept[1].confidence, 0.79)

    def test_detector_reports_truthful_status_matching_opencv_availability(self) -> None:
        cv_status = get_opencv_status()
        res = detect_persons_in_video(
            video_path=self.clip,
            video_file_id="vid-test-1",
            camera_id="cam-test-1",
            engine_id="opencv-person-detector",
            sample_fps=2.0,
            confidence_threshold=0.45,
        )
        if cv_status.available:
            self.assertTrue(res.executed)
            self.assertEqual(res.status, "completed")
            self.assertGreater(res.frames_analyzed, 0)
        else:
            self.assertFalse(res.executed)
            self.assertEqual(res.status, "missing_dependency")
            self.assertEqual(res.events, [])
            self.assertIn("opencv", res.reason.lower())

    def test_engine_registry_and_biometric_policy_guard(self) -> None:
        engines = {e["id"]: e for e in get_registered_engines()}
        self.assertEqual(engines["biometric-matching-guard"]["status"], "disabled_by_policy")
        self.assertEqual(engines["privacy-redaction-filter"]["status"], "ready")

        denied = run_stage1_safe_pipeline("biometric-matching-guard", "vid-1")
        self.assertFalse(denied.executed)
        self.assertEqual(denied.status, "denied_by_policy")


if __name__ == "__main__":
    unittest.main()
