# Running, Testing & Desktop Release Guide (Stage 3)

## 1. Web / Local Runtime Preview (Node + SQLite + FFmpeg)

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## 2. Python FastAPI Backend

Requires Python 3.11+, `ffmpeg`/`ffprobe` on `PATH`, and `backend/requirements.txt`:

```bash
python3 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --host 127.0.0.1 --port 8420 --reload
```

## 3. Desktop Installers & Release Builds (Tauri 2.x)

Install the Rust toolchain (`https://rustup.rs`) and `@tauri-apps/cli`:

```bash
npm install -D @tauri-apps/cli
```

> **Note on Bundled Runtimes**: `desktop/src-tauri/tauri.conf.json` bundles `backend/`, `ai_engine/`, `video_processing/`, and `database/`. For standalone distribution on target machines without system Python/FFmpeg, stage a relocatable `.venv/` (or `python/`) and `bin/ffmpeg[.exe]` inside `desktop/src-tauri/` resources — `desktop/src-tauri/src/lib.rs` automatically resolves bundled Python and `LUMAFLUX_FFMPEG_BIN` and sets `LUMAFLUX_VAULT_DIR` to the OS `app_local_data_dir()`.

### Windows 10 & Windows 11 (`x86_64-pc-windows-msvc`)
- Prerequisites: Visual Studio C++ Build Tools, WebView2 Runtime (`downloadBootstrapper` for Windows 10), Rust `x86_64-pc-windows-msvc`, Python 3.11+ (`backend/requirements.txt`), FFmpeg.
- Build `.msi` and NSIS `.exe`:
  ```powershell
  npx tauri build --config desktop/src-tauri/tauri.conf.json --target x86_64-pc-windows-msvc
  ```
- Recommended Release Signing: Sign generated `.msi` and `.exe` installers with an Authenticode certificate (`signtool.exe sign /fd SHA256 ...`).

### macOS Intel (`x86_64-apple-darwin`) & Apple Silicon (`aarch64-apple-darwin`)
- Prerequisites: Xcode Command Line Tools (`xcode-select --install`), Rust targets (`rustup target add x86_64-apple-darwin aarch64-apple-darwin`), Python 3.11+ (`backend/requirements.txt`), FFmpeg (`brew install ffmpeg`).
- Build Intel `.app`/`.dmg`:
  ```bash
  npx tauri build --config desktop/src-tauri/tauri.conf.json --target x86_64-apple-darwin
  ```
- Build Apple Silicon `.app`/`.dmg`:
  ```bash
  npx tauri build --config desktop/src-tauri/tauri.conf.json --target aarch64-apple-darwin
  ```
- Build Universal Binary:
  ```bash
  npx tauri build --config desktop/src-tauri/tauri.conf.json --target universal-apple-darwin
  ```
- Recommended Release Signing & Notarization: `codesign --deep --force --options runtime --sign "Developer ID Application: ..."` and `xcrun notarytool submit ... --wait`.

## 4. Physical CCTV / NVR Hardware Verification Checklist
1. Open **Camera & NVR Management** and click **Discover ONVIF** (UDP WS-Discovery `239.255.255.250:3702`).
2. Add or select a discovered camera, enter its RTSP/ONVIF username and password (vaulted locally), choose **RTSP TCP** or **RTSP UDP** and **Main/Sub** stream profile, and click **Probe**. Confirm all 6 verification stages (`Discovered -> Auth -> Info -> Profiles -> URI -> RTSP`) turn green.
3. Click **Start Stream**, verify live MJPEG preview and on-demand **Snapshot**, start/stop **Record MP4** (verified via `ffprobe` + decode check), and test **Manual Reconnect**.
4. Add an NVR (`Standard ONVIF + RTSP NVR` or `Generic RTSP Channel Template`), run **Test Auth** and **Discover Channels**, toggle channel availability, and click **Register Camera** on active channels.

## 5. Automated Verification Suite

```bash
python3 -m compileall -q backend ai_engine video_processing tests
python3 -m unittest discover -s tests -p "test_*.py" -v
python3 -m pytest -v
npm test
npm run lint
npm run build
```
