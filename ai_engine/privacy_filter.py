"""Stage 2 Phase F: Privacy masking filter (OpenCV frame blur/pixelate + FFmpeg region redaction export)."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from typing import Any, Literal

from ai_engine.interfaces import BasePrivacyFilter
from video_processing.ffmpeg_probe import is_ffmpeg_available, probe_video_file
from video_processing.opencv_reader import get_opencv_status

MaskMode = Literal["blur", "pixelate"]


class OpenCVPrivacyFilter(BasePrivacyFilter):
    """Applies irreversible Gaussian blur or pixelation to bounding-box regions on decoded frames."""

    def __init__(self, mode: MaskMode = "blur") -> None:
        self.mode: MaskMode = "pixelate" if mode == "pixelate" else "blur"

    def apply_mask(self, frame: Any, regions: list[tuple[int, int, int, int]]) -> Any:
        cv_status = get_opencv_status()
        if not cv_status.available or frame is None or not regions:
            return frame
        import cv2  # type: ignore[import-not-found]

        out = frame.copy()
        img_h, img_w = out.shape[:2]
        for x, y, w, h in regions:
            x1 = max(0, int(x))
            y1 = max(0, int(y))
            x2 = min(img_w, x1 + max(1, int(w)))
            y2 = min(img_h, y1 + max(1, int(h)))
            if x2 <= x1 or y2 <= y1:
                continue
            roi = out[y1:y2, x1:x2]
            if self.mode == "pixelate":
                small_w = max(4, (x2 - x1) // 12)
                small_h = max(4, (y2 - y1) // 12)
                temp = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_LINEAR)
                out[y1:y2, x1:x2] = cv2.resize(temp, (x2 - x1, y2 - y1), interpolation=cv2.INTER_NEAREST)
            else:
                out[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (35, 35), 18)
        return out


def build_ffmpeg_privacy_filter(
    regions: list[dict[str, int]],
    mode: MaskMode = "blur",
    frame_width: int = 1280,
    frame_height: int = 720,
) -> str:
    """Build an FFmpeg -filter_complex / -vf string for blur or pixelation masking."""
    mask_filter = (
        "scale=max(4\\,iw/12):max(4\\,ih/12):flags=neighbor,scale=iw*12:ih*12:flags=neighbor"
        if mode == "pixelate"
        else "boxblur=16:3"
    )
    if not regions:
        return f"[0:v]{mask_filter},format=yuv420p[vout]"

    safe_regions: list[tuple[int, int, int, int]] = []
    for r in regions[:12]:
        x = max(0, min(frame_width - 8, int(r.get("x", 0))))
        y = max(0, min(frame_height - 8, int(r.get("y", 0))))
        w = max(16, min(frame_width - x, int(r.get("w", 120))))
        h = max(16, min(frame_height - y, int(r.get("h", 160))))
        # Pixelate scale needs even dimensions >= 16
        w = w - (w % 2)
        h = h - (h % 2)
        if w >= 16 and h >= 16:
            safe_regions.append((x, y, w, h))

    if not safe_regions:
        return f"[0:v]{mask_filter},format=yuv420p[vout]"

    parts = [f"[0:v]split={len(safe_regions) + 1}[base]" + "".join(f"[rsrc{i}]" for i in range(len(safe_regions)))]
    prev = "[base]"
    for i, (x, y, w, h) in enumerate(safe_regions):
        region_op = (
            f"scale=max(4\\,{w}/12):max(4\\,{h}/12):flags=neighbor,scale={w}:{h}:flags=neighbor"
            if mode == "pixelate"
            else "boxblur=14:3"
        )
        parts.append(f"[rsrc{i}]crop={w}:{h}:{x}:{y},{region_op}[masked{i}]")
        next_lbl = "[vout]" if i == len(safe_regions) - 1 else f"[tmp{i}]"
        if i == len(safe_regions) - 1:
            parts.append(f"{prev}[masked{i}]overlay={x}:{y},format=yuv420p{next_lbl}")
        else:
            parts.append(f"{prev}[masked{i}]overlay={x}:{y}{next_lbl}")
        prev = next_lbl
    return ";".join(parts)


def export_privacy_masked_video(
    input_path: Path,
    output_path: Path,
    regions: list[dict[str, int]],
    mode: MaskMode = "blur",
) -> dict[str, Any]:
    """Export an MP4 copy with privacy masking applied via FFmpeg."""
    if not is_ffmpeg_available():
        raise RuntimeError("FFmpeg is required for privacy-masked video export.")
    if not input_path.exists():
        raise FileNotFoundError(f"Source video not found: {input_path}")

    meta = probe_video_file(input_path)
    fw = meta.width or 1280
    fh = meta.height or 720
    filter_graph = build_ffmpeg_privacy_filter(regions, mode=mode, frame_width=fw, frame_height=fh)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-filter_complex",
            filter_graph,
            "-map",
            "[vout]",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-pix_fmt",
            "yuv420p",
            "-an",
            str(output_path),
        ],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
        err = proc.stderr.decode("utf-8", errors="ignore").strip() or "FFmpeg privacy export failed."
        raise RuntimeError(err)

    out_meta = probe_video_file(output_path)
    sha = hashlib.sha256(output_path.read_bytes()).hexdigest()
    return {
        "output_path": str(output_path),
        "size_bytes": output_path.stat().st_size,
        "sha256": sha,
        "mode": mode,
        "regions_masked": len(regions),
        "metadata": out_meta.to_dict(),
    }
