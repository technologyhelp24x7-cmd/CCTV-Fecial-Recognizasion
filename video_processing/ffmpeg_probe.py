"""FFmpeg metadata extraction and thumbnail generation for local video assets."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional


@dataclass
class VideoMetadata:
    duration_seconds: Optional[float]
    width: Optional[int]
    height: Optional[int]
    fps: Optional[float]
    codec: Optional[str]
    file_size_bytes: int

    def to_dict(self) -> dict:
        return asdict(self)


def is_ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def is_ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def _parse_ffmpeg_stderr(stderr_text: str) -> tuple[Optional[float], Optional[int], Optional[int], Optional[float], Optional[str]]:
    duration_seconds: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    codec: Optional[str] = None

    dur_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr_text)
    if dur_match:
        h, m, s = int(dur_match.group(1)), int(dur_match.group(2)), float(dur_match.group(3))
        duration_seconds = round(h * 3600 + m * 60 + s, 3)

    stream_match = re.search(
        r"Video:\s*([a-zA-Z0-9_\-]+).*?,\s*(\d{2,5})x(\d{2,5})(?:[^,\n]*,\s*(\d+(?:\.\d+)?)\s*fps)?",
        stderr_text,
    )
    if stream_match:
        codec = stream_match.group(1)
        width = int(stream_match.group(2))
        height = int(stream_match.group(3))
        if stream_match.group(4):
            fps = float(stream_match.group(4))

    return duration_seconds, width, height, fps, codec


def probe_video_file(file_path: Path) -> VideoMetadata:
    """Extract real metadata from a local video file using ffprobe or ffmpeg."""
    if not file_path.exists() or not file_path.is_file():
        raise FileNotFoundError(f"Video file does not exist: {file_path}")

    size_bytes = file_path.stat().st_size

    if is_ffprobe_available():
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            payload = json.loads(proc.stdout)
            video_stream = next(
                (s for s in payload.get("streams", []) if s.get("codec_type") == "video"),
                None,
            )
            fmt = payload.get("format", {})
            duration = float(fmt["duration"]) if fmt.get("duration") else None
            width = int(video_stream["width"]) if video_stream and video_stream.get("width") else None
            height = int(video_stream["height"]) if video_stream and video_stream.get("height") else None
            codec = video_stream.get("codec_name") if video_stream else None
            fps = None
            if video_stream and video_stream.get("r_frame_rate") and "/" in video_stream["r_frame_rate"]:
                num_s, den_s = video_stream["r_frame_rate"].split("/", 1)
                den = float(den_s)
                if den > 0:
                    fps = round(float(num_s) / den, 2)
            return VideoMetadata(duration, width, height, fps, codec, size_bytes)

    if is_ffmpeg_available():
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-i", str(file_path)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        duration, width, height, fps, codec = _parse_ffmpeg_stderr(proc.stderr)
        return VideoMetadata(duration, width, height, fps, codec, size_bytes)

    return VideoMetadata(None, None, None, None, None, size_bytes)


def extract_thumbnail(video_path: Path, output_path: Path, timestamp_sec: float = 0.5) -> bool:
    """Extract a single JPEG poster frame using ffmpeg if available."""
    if not is_ffmpeg_available() or not video_path.exists():
        return False

    output_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{max(0.0, timestamp_sec):.2f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2",
            "-q:v",
            "3",
            str(output_path),
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return proc.returncode == 0 and output_path.exists() and output_path.stat().st_size > 0
