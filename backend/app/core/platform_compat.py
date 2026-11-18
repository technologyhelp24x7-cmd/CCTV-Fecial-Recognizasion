"""Multi-OS platform abstraction, runtime resource telemetry, FFmpeg codec/demuxer inspection, and Windows 7 legacy evaluation."""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any

from video_processing.ffmpeg_probe import is_ffmpeg_available
from video_processing.opencv_reader import get_opencv_status

SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".ts"]


def _read_memory_stats() -> tuple[int | None, int | None]:
    sys_name = platform.system().lower()
    if sys_name == "linux":
        try:
            total_kb = None
            avail_kb = None
            for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    avail_kb = int(line.split()[1])
            return (
                total_kb * 1024 if total_kb is not None else None,
                avail_kb * 1024 if avail_kb is not None else None,
            )
        except OSError:
            return None, None
    return None, None


def _inspect_ffmpeg_capabilities() -> tuple[bool, str | None, list[str], list[str]]:
    if not is_ffmpeg_available():
        return False, None, [], []
    version_line: str | None = None
    demuxers: list[str] = []
    decoders: list[str] = []
    try:
        v_proc = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, timeout=3, check=False)
        if v_proc.stdout:
            version_line = v_proc.stdout.splitlines()[0].strip()
    except Exception:
        pass
    try:
        d_proc = subprocess.run(["ffmpeg", "-hide_banner", "-demuxers"], capture_output=True, text=True, timeout=4, check=False)
        wanted_demuxers = {"mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "avi", "mpegts", "flv", "rtsp", "mjpeg"}
        for line in (d_proc.stdout or "").splitlines():
            parts = line.strip().split()
            if len(parts) >= 2 and parts[0].startswith("D"):
                name = parts[1]
                if name in wanted_demuxers or any(tok in name for tok in ("mp4", "matroska", "mpegts", "rtsp", "avi")):
                    demuxers.append(name)
    except Exception:
        pass
    try:
        c_proc = subprocess.run(["ffmpeg", "-hide_banner", "-decoders"], capture_output=True, text=True, timeout=4, check=False)
        wanted_decoders = {"h264", "hevc", "vp8", "vp9", "av1", "mpeg4", "mjpeg"}
        for line in (c_proc.stdout or "").splitlines():
            parts = line.strip().split()
            if len(parts) >= 2 and parts[0].startswith("V"):
                name = parts[1]
                if name in wanted_decoders:
                    decoders.append(name)
    except Exception:
        pass
    return True, version_line, sorted(set(demuxers)), sorted(set(decoders))


def get_platform_capabilities(storage_dir: Path | None = None) -> dict[str, Any]:
    raw_sys = platform.system().lower()
    os_family = (
        "windows"
        if "win" in raw_sys
        else ("macos" if raw_sys == "darwin" else ("linux" if raw_sys == "linux" else "other"))
    )
    mem_total, mem_free = _read_memory_stats()
    cpu_load = None
    try:
        cpu_load = round(os.getloadavg()[0], 2)
    except (AttributeError, OSError):
        cpu_load = None

    disk_total = None
    disk_free = None
    try:
        target = storage_dir if storage_dir and storage_dir.exists() else Path(".")
        usage = shutil.disk_usage(target)
        disk_total = usage.total
        disk_free = usage.free
    except OSError:
        pass

    ff_ok, ff_ver, demuxers, decoders = _inspect_ffmpeg_capabilities()
    cv_status = get_opencv_status()

    return {
        "os_family": os_family,
        "os_release": f"{platform.system()} {platform.release()}",
        "arch": platform.machine(),
        "hostname": socket.gethostname(),
        "cpu_count": os.cpu_count() or 1,
        "cpu_load_1m": cpu_load,
        "memory_total_bytes": mem_total,
        "memory_free_bytes": mem_free,
        "disk_total_bytes": disk_total,
        "disk_free_bytes": disk_free,
        "ffmpeg_available": ff_ok,
        "ffmpeg_version": ff_ver,
        "opencv_available": cv_status.available,
        "opencv_version": cv_status.version,
        "supported_video_extensions": SUPPORTED_VIDEO_EXTENSIONS,
        "ffmpeg_demuxers": demuxers,
        "ffmpeg_decoders": decoders,
        "desktop_targets": [
            {
                "platform": "Windows 10 / 11",
                "arch": "x86_64",
                "bundle_formats": ["msi", "nsis (.exe)"],
                "runtime_stack": "Tauri 2 + Edge WebView2 + Python 3.11 + FFmpeg",
                "verification_status": "Configured in tauri.conf.json & CI matrix (Pending Win10/11 runner execution)",
                "notes": "Requires WebView2 Evergreen Runtime (preinstalled on Win11 / bootstrapped on Win10).",
            },
            {
                "platform": "macOS Apple Silicon",
                "arch": "arm64 (aarch64-apple-darwin)",
                "bundle_formats": ["dmg", "app"],
                "runtime_stack": "Tauri 2 + WKWebView + Python 3.11 + FFmpeg",
                "verification_status": "Configured in tauri.conf.json & CI matrix (Pending macOS arm64 runner execution)",
                "notes": "Requires macOS 12.0+ and notarization for Gatekeeper distribution.",
            },
            {
                "platform": "macOS Intel",
                "arch": "x86_64-apple-darwin",
                "bundle_formats": ["dmg", "app"],
                "runtime_stack": "Tauri 2 + WKWebView + Python 3.11 + FFmpeg",
                "verification_status": "Configured in tauri.conf.json & CI matrix (Pending macOS x64 runner execution)",
                "notes": "Requires macOS 12.0+ and matching x86_64 Python/OpenCV/FFmpeg binaries.",
            },
            {
                "platform": "Linux Desktop",
                "arch": "x86_64 & aarch64",
                "bundle_formats": ["AppImage", "deb", "rpm"],
                "runtime_stack": "Tauri 2 + WebKitGTK 4.1 + Python 3.11 + FFmpeg",
                "verification_status": "Configured in tauri.conf.json & CI matrix; headless container verified backend/FFmpeg/OpenCV",
                "notes": "Requires libwebkit2gtk-4.1-0 and ffmpeg on Ubuntu 22.04+/Debian 12+/Fedora 39+.",
            },
        ],
        "windows7_legacy_evaluation": {
            "supported_in_main_tauri2_build": False,
            "reason": (
                "Tauri 2 relies on Win32 DPI APIs (GetDpiForWindow) and Microsoft Edge WebView2 >= 110, "
                "both of which ended Windows 7/8.1 support in January 2023. Python 3.11 also requires Windows 8.1+."
            ),
            "recommended_legacy_path": (
                "Separate Legacy Branch only: Tauri v1.6 (or Electron 22.3.x) pinned to WebView2 Fixed Runtime 109.0.1518.78 "
                "paired with Python 3.8.10 x64 backend, strictly isolated from main Win10/11 security baselines."
            ),
            "verification_status": "Evaluated & Documented Only — NOT verified or advertised on physical Windows 7 SP1 hardware.",
        },
    }
