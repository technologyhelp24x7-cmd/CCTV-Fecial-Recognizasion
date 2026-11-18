"""OpenCV video frame capture wrapper for Stage 2 computer vision pipelines."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class OpenCVStatus:
    available: bool
    version: Optional[str]


def get_opencv_status() -> OpenCVStatus:
    try:
        import cv2  # type: ignore

        return OpenCVStatus(available=True, version=getattr(cv2, "__version__", "unknown"))
    except ImportError:
        return OpenCVStatus(available=False, version=None)


class OpenCVVideoReader:
    """Safe wrapper around cv2.VideoCapture with deterministic resource cleanup."""

    def __init__(self, source: Path | str) -> None:
        self.source = str(source)
        self._cap = None

    def open(self) -> None:
        try:
            import cv2  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "OpenCV (opencv-python-headless) is not installed in the active Python environment."
            ) from exc

        cap = cv2.VideoCapture(self.source)
        if not cap.isOpened():
            cap.release()
            raise IOError(f"Unable to open video source: {self.source}")
        self._cap = cap

    def read_frame_count(self) -> int:
        if self._cap is None:
            raise RuntimeError("VideoCapture is not open")
        import cv2  # type: ignore

        return int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def __enter__(self) -> "OpenCVVideoReader":
        self.open()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()
