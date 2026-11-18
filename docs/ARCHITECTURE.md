# LumaFlux Intelligence — Architecture Overview (Stage 3)

## 1. Selected Desktop Framework: Tauri 2.x

Tauri 2.x (`desktop/src-tauri/`) is used for Windows 10/11 and macOS (Intel & Apple Silicon) desktop packaging:

- **Memory & Compute Headroom**: Tauri uses native OS WebViews (WebView2 on Windows 10/11, WKWebView on macOS) instead of bundling Chromium per process, preserving RAM and CPU headroom for OpenCV and FFmpeg multi-stream pipelines.
- **Sidecar Lifecycle & Graceful Shutdown**: `desktop/src-tauri/src/lib.rs` allocates an isolated loopback port, generates an ephemeral `LUMAFLUX_API_TOKEN`, spawns the Python FastAPI backend (`uvicorn backend.app.main:app`), injects OS `app_local_data_dir()` paths (`LUMAFLUX_DB_PATH`, `LUMAFLUX_STORAGE_DIR`, `LUMAFLUX_THUMBNAIL_DIR`, `LUMAFLUX_LOG_DIR`, `LUMAFLUX_VAULT_DIR`), resolves bundled Python/FFmpeg binaries, polls HTTP `GET /api/health` before exposing readiness, and invokes authenticated `POST /api/system/shutdown` before process exit so active FFmpeg recording and streaming workers terminate cleanly without orphaned child processes.
- **Capability Security**: `desktop/src-tauri/capabilities/default.json` limits renderer permissions to approved native dialogs and loopback API traffic.

## 2. Layered System Structure

- `desktop/src-tauri/`: Rust desktop shell, sidecar lifecycle, graceful shutdown, native folder picker, platform installer bundling (MSI/NSIS/DMG/APP).
- `src/`: React 19 + TypeScript + Tailwind CSS v4 frontend UI covering all 11 operational modules including Camera & NVR Management, ONVIF LAN Discovery, and 6-Stage Verification Readouts.
- `server.ts` & `server/`: Node/Express runtime gateway with full Stage 3 SQLite WAL + CredentialVault + ONVIF + NVR + RTSP parity for web preview and dual-runtime verification.
- `backend/`: Python 3.11 + FastAPI backend service (`uvicorn backend.app.main:app`) with lifespan recovery, rotating structured logs, credential vault integration, NVR routes, and graceful shutdown.
- `video_processing/`:
  - `onvif_client.py`: UDP WS-Discovery (`239.255.255.250:3702`), SOAP WS-UsernameToken + HTTP Digest Authentication (`MD5`/`SHA-256`), `GetSystemDateAndTime`, `GetDeviceInformation`, `GetCapabilities`, `GetServices`, `GetProfiles`, `GetStreamUri`, and 6-stage `VerificationStages` pipeline.
  - `camera_connector.py`: RTSP TCP/UDP, ONVIF, HTTP/HLS, and local archive probing, in-memory credential injection, and `verify_mp4_integrity` decode validation.
  - `nvr_connector.py`: Vendor-neutral NVR adapter registry (`standard_onvif_rtsp` + `generic_rtsp_channels`) extensible for future proprietary vendor SDK plugins without modifying core routing.
  - `stream_worker.py`: Concurrent FFmpeg MJPEG live preview (`4 MB` bounded frame buffer, `frames_dropped`/`bytes_received`/`avg_frame_ms` telemetry), on-demand snapshot capture, fragmented MP4 recording with `ffprobe` + FFmpeg decode integrity verification, and concurrency limits (`max_concurrent_streams`, `max_concurrent_recordings`).
- `ai_engine/`: OpenCV HOG + SVM person detector and MOG2 silhouette detector with session-scoped anonymous tracking (`BIOMETRIC_IDENTIFICATION_ENABLED = False`).
- `database/`: Canonical `schema.sql` (`cameras`, `nvrs`, `nvr_channels`, `camera_stream_sessions`, `recording_sessions`, `video_files`, `person_events`, `anonymous_tracks`, `person_profiles`, `watchlist_reviews`, `processing_jobs`, `audit_logs`, `app_settings`) with ANSI-portable UUID/ISO-8601 types for PostgreSQL migration.
- `shared/`: Shared TypeScript API contracts (`shared/types.ts`).
- `tests/`: Python `unittest`/`pytest` suites (`tests/test_*.py`) and Node API integration tests (`tests/test_api_integration.mjs`).
