"""Unit tests for FFmpeg probing, thumbnail extraction, OpenCV wrapper, and Stage 1 AI guardrails."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from ai_engine.registry import BIOMETRIC_IDENTIFICATION_ENABLED, get_registered_engines, run_stage1_safe_pipeline
from video_processing.ffmpeg_probe import extract_thumbnail, is_ffmpeg_available, probe_video_file
from video_processing.opencv_reader import get_opencv_status


class TestVideoAndAiModules(unittest.TestCase):
    def test_biometric_identification_disabled_in_stage1(self) -> None:
        self.assertFalse(BIOMETRIC_IDENTIFICATION_ENABLED)
        engines = get_registered_engines()
        bio = next(e for e in engines if e["id"] == "biometric-matching-guard")
        self.assertEqual(bio["status"], "disabled_by_policy")

        denied = run_stage1_safe_pipeline("biometric-matching-guard", "vid-1")
        self.assertFalse(denied.executed)
        self.assertEqual(denied.status, "denied_by_policy")
        self.assertEqual(denied.events_detected, 0)

        cv_result = run_stage1_safe_pipeline("opencv-person-detector", "vid-1")
        if get_opencv_status().available:
            self.assertTrue(cv_result.executed)
            self.assertEqual(cv_result.status, "ready")
        else:
            self.assertFalse(cv_result.executed)
            self.assertEqual(cv_result.status, "skipped")
        self.assertEqual(cv_result.events_detected, 0)

    def test_opencv_status_reports_boolean(self) -> None:
        status = get_opencv_status()
        self.assertIsInstance(status.available, bool)

    def test_ffmpeg_probe_and_thumbnail_on_real_clip(self) -> None:
        if not is_ffmpeg_available():
            self.skipTest("ffmpeg binary not installed")

        with tempfile.TemporaryDirectory() as tmp_dir:
            base = Path(tmp_dir)
            clip_path = base / "sample.mp4"
            thumb_path = base / "thumb.jpg"

            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=320x240:d=1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    str(clip_path),
                ],
                check=True,
                capture_output=True,
                timeout=15,
            )

            meta = probe_video_file(clip_path)
            self.assertEqual(meta.width, 320)
            self.assertEqual(meta.height, 240)
            self.assertGreater(meta.file_size_bytes, 0)
            self.assertIsNotNone(meta.duration_seconds)

            extracted = extract_thumbnail(clip_path, thumb_path, timestamp_sec=0.1)
            self.assertTrue(extracted)
            self.assertTrue(thumb_path.exists())
            self.assertGreater(thumb_path.stat().st_size, 0)


if __name__ == "__main__":
    unittest.main()
