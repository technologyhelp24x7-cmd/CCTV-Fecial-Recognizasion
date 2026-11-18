"""Stage 2 Phase D + F unit tests: anonymous session tracking, event cropping, and privacy redaction export."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from ai_engine.privacy_filter import build_ffmpeg_privacy_filter, export_privacy_masked_video
from ai_engine.tracker import AnonymousSessionTracker, RawDetection, extract_event_crop
from video_processing.ffmpeg_probe import probe_video_file


class TestTrackerAndPrivacy(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.clip = self.base / "scene.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=10:duration=2",
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

    def test_tracker_deduplicates_consecutive_frames_into_single_event(self) -> None:
        tracker = AnonymousSessionTracker(camera_id="cam01-east", video_file_id="vid-1", max_gap_sec=1.5)
        detections = [
            RawDetection(0.5, 5, 0.62, {"x": 80, "y": 40, "w": 60, "h": 140}, "opencv-hog-svm"),
            RawDetection(1.0, 10, 0.84, {"x": 92, "y": 42, "w": 60, "h": 140}, "opencv-hog-svm"),
            RawDetection(1.5, 15, 0.71, {"x": 105, "y": 41, "w": 60, "h": 140}, "opencv-hog-svm"),
            # Re-entry after gap > 1.5s -> should produce a second event on the same or new track
            RawDetection(4.2, 42, 0.79, {"x": 110, "y": 40, "w": 60, "h": 140}, "opencv-hog-svm"),
        ]
        tracks, events = tracker.process_detections(detections)
        self.assertEqual(len(tracks), 2)
        self.assertEqual(len(events), 2)
        self.assertTrue(events[0].track_code.startswith("TRK-CAM0-"))
        self.assertEqual(events[0].frame_count, 3)
        self.assertAlmostEqual(events[0].start_timestamp_sec, 0.5)
        self.assertAlmostEqual(events[0].end_timestamp_sec, 1.5)
        self.assertAlmostEqual(events[0].peak_confidence, 0.84)
        self.assertEqual(events[0].best_frame_number, 10)

    def test_tracker_strictly_isolates_cameras_without_cross_camera_linking(self) -> None:
        t_cam1 = AnonymousSessionTracker(camera_id="camA", video_file_id="vid-a")
        t_cam2 = AnonymousSessionTracker(camera_id="camB", video_file_id="vid-b")
        _, ev1 = t_cam1.process_detections([RawDetection(1.0, 10, 0.8, {"x": 50, "y": 40, "w": 60, "h": 140}, "hog")])
        _, ev2 = t_cam2.process_detections([RawDetection(1.1, 11, 0.8, {"x": 50, "y": 40, "w": 60, "h": 140}, "hog")])
        self.assertNotEqual(ev1[0].track_id, ev2[0].track_id)
        self.assertTrue(ev1[0].track_code.startswith("TRK-CAMA-"))
        self.assertTrue(ev2[0].track_code.startswith("TRK-CAMB-"))

    def test_extract_event_crop_creates_valid_jpeg(self) -> None:
        out_jpg = self.base / "crops" / "evt1.jpg"
        saved = extract_event_crop(
            video_path=self.clip,
            output_path=out_jpg,
            timestamp_sec=0.5,
            bbox={"x": 40, "y": 20, "w": 120, "h": 160},
            apply_privacy_blur=True,
        )
        self.assertIsNotNone(saved)
        assert saved is not None
        raw = saved.read_bytes()
        self.assertTrue(raw.startswith(b"\xff\xd8"))
        self.assertTrue(raw.endswith(b"\xff\xd9"))

    def test_privacy_masked_video_export_blur_and_pixelate(self) -> None:
        filter_str = build_ffmpeg_privacy_filter([{"x": 40, "y": 30, "w": 80, "h": 120}], mode="pixelate", frame_width=320, frame_height=240)
        self.assertIn("overlay=40:30", filter_str)

        blur_out = self.base / "redacted_blur.mp4"
        blur_res = export_privacy_masked_video(
            input_path=self.clip,
            output_path=blur_out,
            regions=[{"x": 40, "y": 30, "w": 80, "h": 120}],
            mode="blur",
        )
        self.assertGreater(blur_res["size_bytes"], 0)
        self.assertEqual(blur_res["metadata"]["width"], 320)

        pix_out = self.base / "redacted_pix.mp4"
        pix_res = export_privacy_masked_video(
            input_path=self.clip,
            output_path=pix_out,
            regions=[{"x": 40, "y": 30, "w": 80, "h": 120}],
            mode="pixelate",
        )
        self.assertGreater(pix_res["size_bytes"], 0)
        meta = probe_video_file(pix_out)
        self.assertEqual(meta.width, 320)
        self.assertEqual(meta.height, 240)


if __name__ == "__main__":
    unittest.main()
