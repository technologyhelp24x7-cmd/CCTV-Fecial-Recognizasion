use serde::Serialize;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Default)]
pub struct BackendProcessState {
    pub child: Mutex<Option<Child>>,
    pub backend_port: Mutex<u16>,
    pub api_token: Mutex<String>,
    pub backend_error: Mutex<Option<String>>,
}

#[derive(Serialize)]
pub struct DesktopRuntimeInfo {
    pub app_name: String,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub backend_url: String,
    pub api_token: String,
    pub data_dir: String,
    pub backend_ready: bool,
    pub backend_error: Option<String>,
}

fn generate_ephemeral_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    format!("lfx-{:x}-{:x}", nanos, pid ^ 0x9E37_79B9_7F4A_7C15u128)
}

fn allocate_loopback_port(preferred: u16) -> u16 {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", preferred)) {
        return listener.local_addr().map(|a| a.port()).unwrap_or(preferred);
    }
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) {
        return listener.local_addr().map(|a| a.port()).unwrap_or(preferred);
    }
    preferred
}

fn probe_backend_health_once(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(350)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
        let req = format!(
            "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            port
        );
        if stream.write_all(req.as_bytes()).is_ok() {
            let mut buf = [0u8; 256];
            if let Ok(n) = stream.read(&mut buf) {
                let head = String::from_utf8_lossy(&buf[..n]);
                return head.contains(" 200 ");
            }
        }
    }
    false
}

fn wait_for_backend_health(port: u16, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if probe_backend_health_once(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn resolve_backend_root(app: &AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        if resource_dir.join("backend").exists() {
            return resource_dir;
        }
        let up_root = resource_dir.join("_up_").join("_up_");
        if up_root.join("backend").exists() {
            return up_root;
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("backend").exists() {
            return cwd;
        }
        if let Some(parent) = cwd.parent() {
            if parent.join("backend").exists() {
                return parent.to_path_buf();
            }
            if let Some(grandparent) = parent.parent() {
                if grandparent.join("backend").exists() {
                    return grandparent.to_path_buf();
                }
            }
        }
    }
    PathBuf::from(".")
}

fn resolve_python_executable(backend_root: &Path) -> String {
    if let Ok(explicit) = std::env::var("LUMAFLUX_PYTHON_BIN") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    let candidates = if cfg!(target_os = "windows") {
        vec![
            backend_root.join(".venv").join("Scripts").join("python.exe"),
            backend_root.join("python").join("python.exe"),
        ]
    } else {
        vec![
            backend_root.join(".venv").join("bin").join("python3"),
            backend_root.join(".venv").join("bin").join("python"),
            backend_root.join("python").join("bin").join("python3"),
        ]
    };

    for candidate in candidates {
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }

    if cfg!(target_os = "windows") {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

fn resolve_bundled_ffmpeg(backend_root: &Path) -> Option<PathBuf> {
    let exe_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let candidates = vec![
        backend_root.join("bin").join(exe_name),
        backend_root.join("ffmpeg").join("bin").join(exe_name),
        backend_root.join("ffmpeg").join(exe_name),
    ];
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
fn get_runtime_info(
    app: AppHandle,
    state: State<'_, BackendProcessState>,
) -> Result<DesktopRuntimeInfo, String> {
    let port = *state.backend_port.lock().map_err(|e| e.to_string())?;
    let api_token = state.api_token.lock().map_err(|e| e.to_string())?.clone();
    let backend_error = state.backend_error.lock().map_err(|e| e.to_string())?.clone();
    let data_dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./storage"))
        .to_string_lossy()
        .to_string();

    let backend_ready = probe_backend_health_once(port);

    Ok(DesktopRuntimeInfo {
        app_name: "LumaFlux Intelligence".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        backend_url: format!("http://127.0.0.1:{}", port),
        api_token,
        data_dir,
        backend_ready,
        backend_error,
    })
}

#[tauri::command]
fn pick_storage_directory(app: AppHandle, title: Option<String>) -> Option<String> {
    let mut builder = app.dialog().file();
    if let Some(t) = title {
        builder = builder.set_title(&t);
    }
    builder
        .blocking_pick_folder()
        .map(|folder| folder.to_string())
}

fn spawn_python_backend(app: &AppHandle, port: u16, api_token: &str) -> Result<Child, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./storage"));
    std::fs::create_dir_all(data_dir.join("videos")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(data_dir.join("thumbnails")).map_err(|e| e.to_string())?;
    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;

    let backend_root = resolve_backend_root(app);
    let python_bin = resolve_python_executable(&backend_root);

    let mut cmd = Command::new(&python_bin);
    cmd.current_dir(&backend_root)
        .args([
            "-m",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .env("PYTHONPATH", &backend_root)
        .env("LUMAFLUX_BACKEND_PORT", port.to_string())
        .env("LUMAFLUX_API_TOKEN", api_token)
        .env("LUMAFLUX_VAULT_DIR", &data_dir)
        .env("LUMAFLUX_DB_PATH", data_dir.join("lumaflux.db"))
        .env("LUMAFLUX_STORAGE_DIR", data_dir.join("videos"))
        .env("LUMAFLUX_THUMBNAIL_DIR", data_dir.join("thumbnails"))
        .env("LUMAFLUX_LOG_DIR", &log_dir)
        .stdin(Stdio::null());

    if let Some(ffmpeg_path) = resolve_bundled_ffmpeg(&backend_root) {
        cmd.env("LUMAFLUX_FFMPEG_BIN", &ffmpeg_path);
        if let Some(bin_dir) = ffmpeg_path.parent() {
            let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
            let current_path = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{}{}{}", bin_dir.to_string_lossy(), sep, current_path));
        }
    }

    if let Ok(stderr_file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("backend-stderr.log"))
    {
        if let Ok(stdout_dup) = stderr_file.try_clone() {
            cmd.stdout(Stdio::from(stdout_dup));
        }
        cmd.stderr(Stdio::from(stderr_file));
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to spawn Python backend ({}): {}", python_bin, e))
}

fn send_graceful_shutdown_request(port: u16, api_token: &str) {
    if port == 0 {
        return;
    }
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
        let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
        let req = format!(
            "POST /api/system/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            port, api_token
        );
        let _ = stream.write_all(req.as_bytes());
        let mut sink = [0u8; 64];
        let _ = stream.read(&mut sink);
    }
}

fn terminate_python_backend(state: &BackendProcessState) {
    let port = state.backend_port.lock().map(|g| *g).unwrap_or(0);
    let token = state.api_token.lock().map(|g| g.clone()).unwrap_or_default();

    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            send_graceful_shutdown_request(port, &token);
            let deadline = std::time::Instant::now() + Duration::from_millis(3000);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    _ => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let backend_port = allocate_loopback_port(8420);
    let api_token = generate_ephemeral_token();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcessState {
            child: Mutex::new(None),
            backend_port: Mutex::new(backend_port),
            api_token: Mutex::new(api_token.clone()),
            backend_error: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![get_runtime_info, pick_storage_directory])
        .setup(move |app| {
            let handle = app.handle();
            let state = app.state::<BackendProcessState>();
            match spawn_python_backend(handle, backend_port, &api_token) {
                Ok(child) => {
                    if let Ok(mut guard) = state.child.lock() {
                        *guard = Some(child);
                    }
                    if !wait_for_backend_health(backend_port, 10000) {
                        if let Ok(mut err_guard) = state.backend_error.lock() {
                            *err_guard = Some(format!(
                                "Backend process started on port {}, still initializing or missing Python dependencies (fastapi/uvicorn).",
                                backend_port
                            ));
                        }
                    }
                }
                Err(err) => {
                    if let Ok(mut err_guard) = state.backend_error.lock() {
                        *err_guard = Some(err);
                    }
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize LumaFlux Intelligence desktop runtime");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            event: tauri::WindowEvent::Destroyed,
            ..
        }
        | RunEvent::ExitRequested { .. }
        | RunEvent::Exit => {
            let state = app_handle.state::<BackendProcessState>();
            terminate_python_backend(&state);
        }
        _ => {}
    });
}
