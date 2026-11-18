import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PlatformCapabilitiesReport } from '../shared/types.ts';

const execFileAsync = promisify(execFile);

export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.ts'];

export async function getPlatformCapabilitiesReport(params: {
  storageDir: string;
  ffmpegAvailable: boolean;
  opencvStatus: { available: boolean; version: string | null };
}): Promise<PlatformCapabilitiesReport> {
  const plat = os.platform();
  const osFamily: PlatformCapabilitiesReport['os_family'] =
    plat === 'win32' ? 'windows' : plat === 'darwin' ? 'macos' : plat === 'linux' ? 'linux' : 'other';

  let diskTotal: number | null = null;
  let diskFree: number | null = null;
  try {
    const target = fs.existsSync(params.storageDir) ? params.storageDir : path.resolve('.');
    const st = fs.statfsSync(target);
    diskTotal = st.blocks * st.bsize;
    diskFree = st.bavail * st.bsize;
  } catch {
    // Statfs fallback
  }

  let ffmpegVersion: string | null = null;
  const ffmpegDemuxers: string[] = [];
  const ffmpegDecoders: string[] = [];

  if (params.ffmpegAvailable) {
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 });
      ffmpegVersion = stdout.split('\n')[0]?.trim() || null;
    } catch {
      // Non-fatal
    }
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-demuxers'], { timeout: 4000 });
      const wanted = new Set(['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'avi', 'mpegts', 'flv', 'rtsp', 'mjpeg']);
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[0].startsWith('D')) {
          const name = parts[1];
          if (wanted.has(name) || /mp4|matroska|mpegts|rtsp|avi/.test(name)) {
            ffmpegDemuxers.push(name);
          }
        }
      }
    } catch {
      // Non-fatal
    }
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-decoders'], { timeout: 4000 });
      const wanted = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mjpeg']);
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[0].startsWith('V') && wanted.has(parts[1])) {
          ffmpegDecoders.push(parts[1]);
        }
      }
    } catch {
      // Non-fatal
    }
  }

  const load = os.loadavg();
  const cpuLoad = plat === 'win32' ? null : Number((load[0] ?? 0).toFixed(2));

  return {
    os_family: osFamily,
    os_release: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    hostname: os.hostname(),
    cpu_count: os.cpus().length || 1,
    cpu_load_1m: cpuLoad,
    memory_total_bytes: os.totalmem(),
    memory_free_bytes: os.freemem(),
    disk_total_bytes: diskTotal,
    disk_free_bytes: diskFree,
    ffmpeg_available: params.ffmpegAvailable,
    ffmpeg_version: ffmpegVersion,
    opencv_available: params.opencvStatus.available,
    opencv_version: params.opencvStatus.version,
    supported_video_extensions: SUPPORTED_VIDEO_EXTENSIONS,
    ffmpeg_demuxers: Array.from(new Set(ffmpegDemuxers)).sort(),
    ffmpeg_decoders: Array.from(new Set(ffmpegDecoders)).sort(),
    desktop_targets: [
      {
        platform: 'Windows 10 / 11',
        arch: 'x86_64',
        bundle_formats: ['msi', 'nsis (.exe)'],
        runtime_stack: 'Tauri 2 + Edge WebView2 + Python 3.11 + FFmpeg',
        verification_status: 'Configured in tauri.conf.json & CI matrix (Pending Win10/11 runner execution)',
        notes: 'Requires WebView2 Evergreen Runtime (preinstalled on Win11 / bootstrapped on Win10).',
      },
      {
        platform: 'macOS Apple Silicon',
        arch: 'arm64 (aarch64-apple-darwin)',
        bundle_formats: ['dmg', 'app'],
        runtime_stack: 'Tauri 2 + WKWebView + Python 3.11 + FFmpeg',
        verification_status: 'Configured in tauri.conf.json & CI matrix (Pending macOS arm64 runner execution)',
        notes: 'Requires macOS 12.0+ and notarization for Gatekeeper distribution.',
      },
      {
        platform: 'macOS Intel',
        arch: 'x86_64-apple-darwin',
        bundle_formats: ['dmg', 'app'],
        runtime_stack: 'Tauri 2 + WKWebView + Python 3.11 + FFmpeg',
        verification_status: 'Configured in tauri.conf.json & CI matrix (Pending macOS x64 runner execution)',
        notes: 'Requires macOS 12.0+ and matching x86_64 Python/OpenCV/FFmpeg binaries.',
      },
      {
        platform: 'Linux Desktop',
        arch: 'x86_64 & aarch64',
        bundle_formats: ['AppImage', 'deb', 'rpm'],
        runtime_stack: 'Tauri 2 + WebKitGTK 4.1 + Python 3.11 + FFmpeg',
        verification_status: 'Configured in tauri.conf.json & CI matrix; container verified backend/FFmpeg/OpenCV',
        notes: 'Requires libwebkit2gtk-4.1-0 and ffmpeg on Ubuntu 22.04+/Debian 12+/Fedora 39+.',
      },
    ],
    windows7_legacy_evaluation: {
      supported_in_main_tauri2_build: false,
      reason:
        'Tauri 2 relies on Win32 DPI APIs (GetDpiForWindow) and Microsoft Edge WebView2 >= 110, both of which ended Windows 7/8.1 support in January 2023. Python 3.11 also requires Windows 8.1+.',
      recommended_legacy_path:
        'Separate Legacy Branch only: Tauri v1.6 (or Electron 22.3.x) pinned to WebView2 Fixed Runtime 109.0.1518.78 paired with Python 3.8.10 x64 backend, strictly isolated from main Win10/11 security baselines.',
      verification_status: 'Evaluated & Documented Only — NOT verified or advertised on physical Windows 7 SP1 hardware.',
    },
  };
}
