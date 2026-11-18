"""Stage 2 Phase B unit tests: live MJPEG streaming worker, reconnect limits, and fragmented MP4 recording."""

from __future__ import annotations

import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from video_processing.stream_worker import StreamAndRecordingManager


class TestStreamAndRecording(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.clip = self.base / "source_loop.mp4"
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
        self.manager = StreamAndRecordingManager()

    def tearDown(self) -> None:
        self.manager.shutdown_all()
        self.tmp.cleanup()

    def test_live_stream_captures_valid_jpeg_frames_and_stops(self) -> None:
        state = self.manager.start_stream(
            session_id="sess-test-1",
            camera_id="cam-test-1",
            source_type="local_archive",
            stream_uri=str(self.clip),
            sample_fps=5.0,
            resolution="320x240",
            max_reconnect_attempts=2,
        )
        self.assertEqual(state.camera_id, "cam-test-1")

        worker = self.manager.get_worker("cam-test-1")
        self.assertIsNotNone(worker)
        assert worker is not None

        frame = None
        deadline = time.time() + 5.0
        while time.time() < deadline:
            frame = worker.get_latest_frame()
            if frame:
                break
            worker.wait_next_frame(timeout=0.5)

        self.assertIsNotNone(frame, "Expected stream worker to buffer at least one JPEG frame")
        assert frame is not None
        self.assertTrue(frame.startswith(b"\xff\xd8"))
        self.assertTrue(frame.endswith(b"\xff\xd9"))
        self.assertGreaterEqual(worker.state.frames_captured, 1)

        stopped = self.manager.stop_stream("cam-test-1")
        self.assertIsNotNone(stopped)
        assert stopped is not None
        self.assertEqual(stopped.status, "stopped")

    def test_fragmented_mp4_recording_produces_valid_playable_file(self) -> None:
        out_path = self.base / "recordings" / "cam-test-2" / "rec_test.mp4"
        rec_id = self.manager.start_recording(
            camera_id="cam-test-2",
            source_type="local_archive",
            stream_uri=str(self.clip),
            output_path=out_path,
        )
        self.assertTrue(rec_id)
        time.sleep(1.3)

        result = self.manager.stop_recording("cam-test-2")
        self.assertIsNotNone(result)
        assert result is not None
        self.assertTrue(result["valid"], f"Expected valid recording metadata, got {result}")
        self.assertGreater(result["size_bytes"], 0)
        self.assertTrue(len(result["sha256"]) == 64)
        self.assertEqual(result["metadata"]["width"], 320)
        self.assertEqual(result["metadata"]["height"], 240)

    def test_missing_local_source_transitions_stream_to_error(self) -> None:
        missing = self.base / "does_not_exist.mp4"
        self.manager.start_stream(
            session_id="sess-err-1",
            camera_id="cam-err-1",
            source_type="local_archive",
            stream_uri=str(missing),
            max_reconnect_attempts=1,
        )
        worker = self.manager.get_worker("cam-err-1")
        assert worker is not None
        deadline = time.time() + 3.0
        while time.time() < deadline and worker.state.status != "error":
            time.sleep(0.1)
        self.assertEqual(worker.state.status, "error")
        self.assertIsNotNone(worker.state.error_message)


if __name__ == "__main__":
    unittest.main()
