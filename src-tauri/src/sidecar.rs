//! Sidecar lifecycle: a free port on 127.0.0.1 (D10, golden rule 3), the runtime venv's
//! Python running `-m app.main` (D1), output tee'd to `<logs>/sidecar.log`, `/health`
//! polling, and guaranteed teardown through `ProcessTree` (golden rule 4). The sidecar
//! also watches this app's pid and exits with it, which covers a forced quit on macOS.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::bootstrap::{sanitize_env, Marker};
use crate::error::{AppError, ErrorCode};
use crate::layout::Layout;
use crate::paths::DataPaths;
use crate::platform::{Device, Precision, ProcessTree};

/// First start imports FastAPI and uvicorn only (torch is imported lazily), but a cold
/// disk cache on first launch after setup can still take a while.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(90);
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

pub struct SidecarProcess {
    tree: ProcessTree,
    pub port: u16,
}

impl SidecarProcess {
    /// `Some(status)` once the process has exited.
    pub fn exit_status(&mut self) -> Option<ExitStatus> {
        self.tree.child().try_wait().ok().flatten()
    }
}

pub struct SpawnOptions<'a> {
    pub layout: &'a Layout,
    pub data: &'a DataPaths,
    pub marker: &'a Marker,
    pub app_version: &'a str,
    pub allowed_origins: &'a [String],
}

/// Bind port 0 and read the assigned port back. The listener closes before the
/// sidecar binds; a lost race shows up as an early exit and the caller retries.
pub fn pick_free_port() -> Result<u16, AppError> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| AppError::with_detail(ErrorCode::SidecarSpawnFailed, e.to_string()))
}

pub fn spawn(opts: &SpawnOptions, port: u16) -> Result<SidecarProcess, AppError> {
    let data = opts.data;
    let mut cmd = Command::new(data.venv_python());
    cmd.args(["-m", "app.main", "--port", &port.to_string()])
        .current_dir(&opts.layout.sidecar_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sanitize_env(&mut cmd);

    let mut python_path = vec![opts.layout.sidecar_dir.clone()];
    if opts.layout.upstream_dir != opts.layout.sidecar_dir {
        python_path.push(opts.layout.upstream_dir.clone());
    }
    if let Ok(joined) = std::env::join_paths(python_path) {
        cmd.env("PYTHONPATH", joined);
    }
    let device = opts.marker.device.unwrap_or(Device::Cpu);
    let precision = opts.marker.precision.unwrap_or(Precision::Fp32);
    cmd.env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONPYCACHEPREFIX", &data.pycache)
        .env("HF_HOME", &data.models)
        // Everything was downloaded during setup; the sidecar works offline.
        .env("HF_HUB_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        .env("IRODORI_DATA_ROOT", &data.root)
        .env("IRODORI_LOG_DIR", &data.logs)
        .env("IRODORI_DEVICE", device.as_str())
        .env("IRODORI_PRECISION", precision.as_str())
        .env("IRODORI_APP_VERSION", opts.app_version)
        .env("IRODORI_PARENT_PID", std::process::id().to_string())
        .env("IRODORI_ALLOWED_ORIGINS", opts.allowed_origins.join(","));
    if let Some(ffmpeg) = &opts.layout.ffmpeg {
        cmd.env("IRODORI_FFMPEG", ffmpeg);
    }
    if let Some(index) = opts.marker.gpu_index {
        cmd.env("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
            .env("CUDA_VISIBLE_DEVICES", index.to_string());
    }
    if cfg!(target_os = "macos") {
        // Unsupported MPS ops fall back to CPU instead of failing (architecture.md).
        cmd.env("PYTORCH_ENABLE_MPS_FALLBACK", "1");
    }

    let mut tree = ProcessTree::spawn(cmd)
        .map_err(|e| AppError::with_detail(ErrorCode::SidecarSpawnFailed, e.to_string()))?;
    let log_path = data.logs.join("sidecar.log");
    let _ = fs::create_dir_all(&data.logs);
    if fs::metadata(&log_path).is_ok_and(|m| m.len() > LOG_ROTATE_BYTES) {
        let _ = fs::rename(&log_path, log_path.with_extension("1.log"));
    }
    if let Some(out) = tree.child().stdout.take() {
        tee(out, log_path.clone());
    }
    if let Some(err) = tree.child().stderr.take() {
        tee(err, log_path);
    }
    Ok(SidecarProcess { tree, port })
}

/// Poll `GET /health` until it answers 200, the process exits, or the timeout passes.
pub fn wait_until_healthy(
    process: &mut SidecarProcess,
    cancelled: &AtomicBool,
) -> Result<(), AppError> {
    let start = Instant::now();
    while start.elapsed() < HEALTH_TIMEOUT {
        if cancelled.load(Ordering::SeqCst) {
            return Err(AppError::with_detail(ErrorCode::Internal, "cancelled"));
        }
        if let Some(status) = process.exit_status() {
            return Err(AppError::with_detail(
                ErrorCode::SidecarExited,
                status.to_string(),
            ));
        }
        if health_ok(process.port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(AppError::new(ErrorCode::SidecarHealthTimeout))
}

fn health_ok(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.take(4096).read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200")
}

fn tee<R: Read + Send + 'static>(reader: R, log_path: PathBuf) {
    thread::spawn(move || {
        let mut file = open_log(&log_path);
        let mut lines = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match lines.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    if let Some(file) = file.as_mut() {
                        let _ = file.write_all(&buf);
                    }
                }
            }
        }
    });
}

fn open_log(path: &Path) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}
