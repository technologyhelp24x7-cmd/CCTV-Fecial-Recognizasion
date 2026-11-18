"""Stage 3: Hardened multi-camera background stream workers, concurrency caps, bounded buffers, and verified MP4 recording."""

from __future__ import annotations

import hashlib
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from video_processing.camera_connector import (
    discover_local_videos,
    sanitize_log_text,
    verify_mp4_integrity,
)
from video_processing.ffmpeg_probe import is_ffmpeg_available

MAX_STREAM_BUFFER_BYTES = 4 * 1024 * 1024  # 4 MB bounded frame accumulation buffer per camera


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_width(resolution: str) -> int:
    try:
        w = int(str(resolution or "1280x720").lower().split("x")[0])
        return min(max(w, 320), 1920)
    except (ValueError, IndexError):
        return 1280


def build_ffmpeg_input_args(
    source_type: str,
    stream_uri: str,
    rtsp_transport: str = "tcp",
) -> Optional[list[str]]:
    if source_type == "local_archive":
        files = discover_local_videos(stream_uri)
        if not files:
            return None
        return ["-re", "-stream_loop", "-1", "-i", str(files[0])]
    if source_type == "rtsp" or (source_type == "onvif" and stream_uri.lower().startswith(("rtsp://", "rtsps://"))):
        transport = "udp" if str(rtsp_transport).lower() == "udp" else "tcp"
        return ["-rtsp_transport", transport, "-i", stream_uri]
    return ["-i", stream_uri]


def capture_single_snapshot_jpeg(
    source_type: str,
    stream_uri: str,
    rtsp_transport: str = "tcp",
    timeout_sec: float = 8.0,
) -> Optional[bytes]:
    """Capture a single live JPEG frame directly via FFmpeg without starting a continuous worker."""
    if not is_ffmpeg_available():
        return None
    if source_type == "local_archive":
        files = discover_local_videos(stream_uri)
        if not files:
            return None
        input_args = ["-ss", "0.2", "-i", str(files[0])]
    elif source_type == "rtsp" or stream_uri.lower().startswith(("rtsp://", "rtsps://")):
        transport = "udp" if str(rtsp_transport).lower() == "udp" else "tcp"
        input_args = ["-rtsp_transport", transport, "-i", stream_uri]
    else:
        input_args = ["-i", stream_uri]

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        *input_args,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "4",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout_sec, check=False)
    except (subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0 or not proc.stdout.startswith(b"\xff\xd8"):
        return None
    return proc.stdout


@dataclass
class StreamState:
    session_id: str
    camera_id: str
    status: str  # starting | streaming | reconnecting | stopped | error
    transport: str
    sample_fps: float
    resolution: str
    frames_captured: int = 0
    frames_dropped: int = 0
    bytes_received: int = 0
    avg_frame_ms: Optional[float] = None
    reconnect_count: int = 0
    last_frame_at: Optional[str] = None
    error_message: Optional[str] = None
    started_at: str = ""
    stopped_at: Optional[str] = None


class CameraStreamWorker:
    """Independent per-camera background capture worker with bounded JPEG buffer and auto-reconnect."""

    def __init__(
        self,
        session_id: str,
        camera_id: str,
        source_type: str,
        stream_uri: str,
        sample_fps: float = 5.0,
        resolution: str = "1280x720",
        max_reconnect_attempts: int = 5,
        rtsp_transport: str = "tcp",
        on_state_change: Optional[Callable[[StreamState], None]] = None,
    ) -> None:
        self.camera_id = camera_id
        self.source_type = source_type
        self.stream_uri = stream_uri
        self.rtsp_transport = "udp" if str(rtsp_transport).lower() == "udp" else "tcp"
        self.max_reconnect_attempts = max(0, max_reconnect_attempts)
        self.on_state_change = on_state_change

        transport_label = f"ffmpeg-{self.rtsp_transport}" if source_type in ("rtsp", "onvif") else "ffmpeg"
        self.state = StreamState(
            session_id=session_id,
            camera_id=camera_id,
            status="starting",
            transport=transport_label,
            sample_fps=min(max(sample_fps, 0.5), 30.0),
            resolution=resolution or "1280x720",
            started_at=_utc_now(),
        )

        self._stop_event = threading.Event()
        self._frame_cond = threading.Condition()
        self._latest_jpeg: Optional[bytes] = None
        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._thread: Optional[threading.Thread] = None
        self._last_frame_mono: Optional[float] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, name=f"lumaflux-stream-{self.camera_id[:8]}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=2.0)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
        self.state.status = "stopped"
        self.state.stopped_at = _utc_now()
        self._emit_state()

    def get_latest_frame(self) -> Optional[bytes]:
        with self._frame_cond:
            return self._latest_jpeg

    def wait_next_frame(self, timeout: float = 2.0) -> Optional[bytes]:
        with self._frame_cond:
            self._frame_cond.wait(timeout=timeout)
            return self._latest_jpeg

    def _emit_state(self) -> None:
        if self.on_state_change:
            try:
                self.on_state_change(self.state)
            except Exception:
                pass

    def _run_loop(self) -> None:
        if not is_ffmpeg_available():
            self.state.status = "error"
            self.state.error_message = "FFmpeg binary unavailable for live stream capture."
            self.state.stopped_at = _utc_now()
            self._emit_state()
            return

        attempt = 0
        while not self._stop_event.is_set():
            input_args = build_ffmpeg_input_args(self.source_type, self.stream_uri, self.rtsp_transport)
            if not input_args:
                self.state.status = "error"
                self.state.error_message = "No readable video source available for streaming."
                self.state.stopped_at = _utc_now()
                self._emit_state()
                return

            width = _parse_width(self.state.resolution)
            cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                *input_args,
                "-vf",
                f"fps={self.state.sample_fps:.2f},scale={width}:-2",
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "-q:v",
                "5",
                "pipe:1",
            ]

            self.state.status = "streaming" if attempt == 0 else "reconnecting"
            self._emit_state()

            try:
                self._proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL,
                )
            except OSError as exc:
                self.state.status = "error"
                self.state.error_message = sanitize_log_text(str(exc), self.stream_uri)
                self.state.stopped_at = _utc_now()
                self._emit_state()
                return

            buf = bytearray()
            assert self._proc.stdout is not None
            while not self._stop_event.is_set():
                chunk = self._proc.stdout.read(8192)
                if not chunk:
                    break
                self.state.bytes_received += len(chunk)
                buf.extend(chunk)
                if len(buf) > MAX_STREAM_BUFFER_BYTES:
                    # Backpressure protection: drop oldest unparsed bytes to cap worker RAM
                    excess = len(buf) - (MAX_STREAM_BUFFER_BYTES // 2)
                    del buf[:excess]
                    self.state.frames_dropped += 1

                while True:
                    soi = buf.find(b"\xff\xd8")
                    if soi == -1:
                        buf.clear()
                        break
                    if soi > 0:
                        del buf[:soi]
                    eoi = buf.find(b"\xff\xd9", 2)
                    if eoi == -1:
                        break
                    frame = bytes(buf[: eoi + 2])
                    del buf[: eoi + 2]
                    now_mono = time.monotonic()
                    if self._last_frame_mono is not None:
                        delta_ms = (now_mono - self._last_frame_mono) * 1000.0
                        if self.state.avg_frame_ms is None:
                            self.state.avg_frame_ms = round(delta_ms, 2)
                        else:
                            self.state.avg_frame_ms = round(0.8 * self.state.avg_frame_ms + 0.2 * delta_ms, 2)
                    self._last_frame_mono = now_mono

                    with self._frame_cond:
                        self._latest_jpeg = frame
                        self._frame_cond.notify_all()
                    self.state.frames_captured += 1
                    self.state.last_frame_at = _utc_now()
                    if self.state.status != "streaming":
                        self.state.status = "streaming"
                        self.state.error_message = None
                        self._emit_state()
                    elif self.state.frames_captured % 15 == 0:
                        self._emit_state()

            stderr_text = ""
            if self._proc.stderr:
                stderr_text = self._proc.stderr.read().decode("utf-8", errors="ignore").strip()
            rc = self._proc.wait()
            for pipe in (self._proc.stdout, self._proc.stderr):
                if pipe:
                    try:
                        pipe.close()
                    except Exception:
                        pass
            self._proc = None

            if self._stop_event.is_set():
                break

            attempt += 1
            self.state.reconnect_count = attempt
            if attempt > self.max_reconnect_attempts:
                self.state.status = "error"
                self.state.error_message = sanitize_log_text(
                    stderr_text or f"Stream exited (code {rc}); exceeded max reconnect limit ({self.max_reconnect_attempts}).",
                    self.stream_uri,
                )
                self.state.stopped_at = _utc_now()
                self._emit_state()
                return

            self.state.status = "reconnecting"
            self.state.error_message = sanitize_log_text(
                stderr_text or f"Connection interrupted (exit {rc}); reconnecting ({attempt}/{self.max_reconnect_attempts})...",
                self.stream_uri,
            )
            self._emit_state()
            time.sleep(min(5.0, 0.5 * attempt))


class StreamAndRecordingManager:
    """Coordinates bounded multi-camera live stream workers and verified MP4 recording processes."""

    def __init__(self, max_streams: int = 8, max_recordings: int = 8) -> None:
        self._lock = threading.Lock()
        self._streams: dict[str, CameraStreamWorker] = {}
        self._recordings: dict[str, tuple[subprocess.Popen[bytes], Path, str]] = {}
        self.max_streams = min(max(int(max_streams), 1), 32)
        self.max_recordings = min(max(int(max_recordings), 1), 32)

    def configure_limits(self, max_streams: Optional[int] = None, max_recordings: Optional[int] = None) -> None:
        with self._lock:
            if max_streams is not None:
                self.max_streams = min(max(int(max_streams), 1), 32)
            if max_recordings is not None:
                self.max_recordings = min(max(int(max_recordings), 1), 32)

    def start_stream(
        self,
        session_id: str,
        camera_id: str,
        source_type: str,
        stream_uri: str,
        sample_fps: float = 5.0,
        resolution: str = "1280x720",
        max_reconnect_attempts: int = 5,
        rtsp_transport: str = "tcp",
        on_state_change: Optional[Callable[[StreamState], None]] = None,
    ) -> StreamState:
        with self._lock:
            existing = self._streams.get(camera_id)
            if existing and existing.state.status in ("starting", "streaming", "reconnecting"):
                return existing.state
            active_count = sum(
                1 for w in self._streams.values() if w.state.status in ("starting", "streaming", "reconnecting")
            )
            if active_count >= self.max_streams:
                raise RuntimeError(
                    f"Maximum concurrent streams limit reached ({self.max_streams}). Stop an active stream or raise max_concurrent_streams."
                )
            worker = CameraStreamWorker(
                session_id=session_id,
                camera_id=camera_id,
                source_type=source_type,
                stream_uri=stream_uri,
                sample_fps=sample_fps,
                resolution=resolution,
                max_reconnect_attempts=max_reconnect_attempts,
                rtsp_transport=rtsp_transport,
                on_state_change=on_state_change,
            )
            self._streams[camera_id] = worker
            worker.start()
            return worker.state

    def stop_stream(self, camera_id: str) -> Optional[StreamState]:
        with self._lock:
            worker = self._streams.pop(camera_id, None)
        if worker:
            worker.stop()
            return worker.state
        return None

    def get_worker(self, camera_id: str) -> Optional[CameraStreamWorker]:
        with self._lock:
            return self._streams.get(camera_id)

    def start_recording(
        self,
        camera_id: str,
        source_type: str,
        stream_uri: str,
        output_path: Path,
        rtsp_transport: str = "tcp",
    ) -> str:
        if not is_ffmpeg_available():
            raise RuntimeError("FFmpeg is required to record camera streams.")
        with self._lock:
            if camera_id in self._recordings:
                raise RuntimeError("Camera is already recording.")
            if len(self._recordings) >= self.max_recordings:
                raise RuntimeError(
                    f"Maximum concurrent recordings limit reached ({self.max_recordings})."
                )
            input_args = build_ffmpeg_input_args(source_type, stream_uri, rtsp_transport)
            if not input_args:
                raise RuntimeError("No readable video source available for recording.")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            cmd = [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                *input_args,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-an",
                "-movflags",
                "+frag_keyframe+empty_moov+default_base_moof",
                str(output_path),
            ]
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            rec_id = str(uuid.uuid4())
            self._recordings[camera_id] = (proc, output_path, rec_id)
            return rec_id

    def stop_recording(self, camera_id: str) -> Optional[dict]:
        with self._lock:
            entry = self._recordings.pop(camera_id, None)
        if not entry:
            return None
        proc, output_path, rec_id = entry
        if proc.poll() is None:
            try:
                if proc.stdin:
                    proc.stdin.write(b"q\n")
                    proc.stdin.flush()
                    proc.stdin.close()
                proc.wait(timeout=4.0)
            except Exception:
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except Exception:
                    proc.kill()
                    proc.wait()
        stderr_text = ""
        if proc.stderr and not proc.stderr.closed:
            try:
                stderr_text = proc.stderr.read().decode("utf-8", errors="ignore").strip()
            except Exception:
                pass
        for pipe in (proc.stdin, proc.stderr):
            if pipe and not pipe.closed:
                try:
                    pipe.close()
                except Exception:
                    pass

        if not output_path.exists() or output_path.stat().st_size == 0:
            return {
                "recording_id": rec_id,
                "output_path": str(output_path),
                "valid": False,
                "error": stderr_text or "Recording produced an empty file.",
            }

        ok, meta_dict, verify_err = verify_mp4_integrity(output_path)
        sha = hashlib.sha256(output_path.read_bytes()).hexdigest()
        return {
            "recording_id": rec_id,
            "output_path": str(output_path),
            "valid": ok,
            "error": verify_err or (stderr_text if not ok else None),
            "size_bytes": output_path.stat().st_size,
            "sha256": sha,
            "metadata": meta_dict,
        }

    def shutdown_all(self) -> None:
        with self._lock:
            cam_ids = list(self._streams.keys())
            rec_ids = list(self._recordings.keys())
        for cid in rec_ids:
            self.stop_recording(cid)
        for cid in cam_ids:
            self.stop_stream(cid)
