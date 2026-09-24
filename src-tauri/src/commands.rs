//! Tauri commands, the shared application state, and the startup and setup flows.
//! Commands return `Result<T, String>` whose error is an error code the frontend
//! translates (D17). The sidecar port reaches the frontend only through
//! `get_sidecar_port` (D10).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bootstrap::{self, Bootstrap, Reporter, SetupProgress, EVENT_SETUP_PROGRESS};
use crate::config::{
    self, DeviceChoice, Settings, TermsAcceptance, SUPPORTED_LOCALES, TERMS_VERSION,
};
use crate::error::{AppError, ErrorCode};
use crate::layout;
use crate::paths::{self, DataPaths};
use crate::platform::{self, DevicePlan, ProbeReport, TorchVariant, TreeKiller};
use crate::sidecar::{self, SidecarProcess, SpawnOptions};

pub const EVENT_STATUS: &str = "app://status";

const GB: u64 = 1_000_000_000;
/// requirements.md §4: ~15 GB (CUDA runtime ≈ 8 GB + models ≈ 4–5 GB + caches).
const REQUIRED_BYTES_CUDA: u64 = 15 * GB;
const REQUIRED_BYTES_OTHER: u64 = 8 * GB;
const SIDECAR_START_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppStatus {
    /// The setup wizard is needed (or running).
    #[default]
    Setup,
    Starting,
    /// The sidecar answers; the model is loading (D4).
    LoadingModel,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusPayload {
    pub status: AppStatus,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BootState {
    pub status: AppStatus,
    pub error: Option<AppError>,
    pub locale: Option<String>,
    pub terms_accepted: bool,
    pub terms_version: u32,
    pub data_root: Option<String>,
    pub default_data_root: Option<String>,
    /// `<data-root>/logs`, shown with errors so users can find the logs.
    pub logs_dir: Option<String>,
    pub device_choice: DeviceChoice,
    pub setup: SetupProgress,
}

#[derive(Debug, Clone, Serialize)]
pub struct DataRootInfo {
    pub path: String,
    pub exists: bool,
    pub free_bytes: Option<u64>,
    pub required_bytes: u64,
    pub issues: Vec<ErrorCode>,
}

#[derive(Default)]
struct Inner {
    status: AppStatus,
    error: Option<AppError>,
    settings: Settings,
    settings_path: Option<PathBuf>,
    default_data_root: Option<PathBuf>,
    probe: Option<ProbeReport>,
    sidecar: Option<SidecarProcess>,
    setup_running: bool,
}

#[derive(Default)]
pub struct AppState {
    inner: Mutex<Inner>,
    setup: Arc<Mutex<SetupProgress>>,
    setup_child: Arc<Mutex<Option<TreeKiller>>>,
    shutting_down: Arc<AtomicBool>,
}

impl AppState {
    fn locked(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }

    fn set_status(&self, app: &AppHandle, status: AppStatus, error: Option<AppError>) {
        {
            let mut inner = self.locked();
            inner.status = status;
            inner.error = error.clone();
        }
        let _ = app.emit(EVENT_STATUS, StatusPayload { status, error });
    }

    fn update_settings(&self, change: impl FnOnce(&mut Settings)) -> Result<(), AppError> {
        let mut inner = self.locked();
        let mut next = inner.settings.clone();
        change(&mut next);
        let path = inner
            .settings_path
            .clone()
            .ok_or_else(|| AppError::new(ErrorCode::SettingsIo))?;
        config::save(&path, &next)
            .map_err(|e| AppError::with_detail(ErrorCode::SettingsIo, e.to_string()))?;
        inner.settings = next;
        Ok(())
    }

    /// Kill everything this app started. Idempotent; called on window close and exit.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(killer) = lock(&self.setup_child).take() {
            killer.kill();
        }
        let sidecar = self.locked().sidecar.take();
        drop(sidecar);
    }
}

/// Load settings and decide between the setup wizard and a direct start.
pub fn initialize(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings_path = paths::settings_file(app).ok();
    let settings = settings_path
        .as_deref()
        .map(config::load)
        .unwrap_or_default();
    let setup_done = settings.terms_accepted()
        && settings.data_root.as_deref().is_some_and(|root| {
            layout::resolve(app).ok().is_some_and(|layout| {
                bootstrap::completed_marker(&layout, &DataPaths::new(root), settings.device)
                    .is_some()
            })
        });
    {
        let mut inner = state.locked();
        inner.settings = settings;
        inner.settings_path = settings_path;
        inner.default_data_root = paths::default_data_root(app).ok();
        inner.status = if setup_done {
            AppStatus::Starting
        } else {
            AppStatus::Setup
        };
    }
    if setup_done {
        let app = app.clone();
        thread::spawn(move || start_sidecar(&app));
    }
}

fn plan_for(inner: &Inner) -> Option<DevicePlan> {
    let probe = inner.probe.as_ref()?;
    Some(match inner.settings.device {
        DeviceChoice::Cpu => probe.cpu.clone(),
        DeviceChoice::Auto => probe.recommended.clone(),
    })
}

// ----- Flows ---------------------------------------------------------------------------

fn start_sidecar(app: &AppHandle) {
    let state = app.state::<AppState>();
    // A retry after an error replaces any sidecar that is still running.
    let previous = state.locked().sidecar.take();
    drop(previous);
    state.set_status(app, AppStatus::Starting, None);
    match launch_sidecar(app, &state) {
        Ok(process) => {
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            state.locked().sidecar = Some(process);
            state.set_status(app, AppStatus::Ready, None);
            watch_sidecar(app.clone());
        }
        Err(err) => state.set_status(app, AppStatus::Error, Some(err)),
    }
}

fn launch_sidecar(app: &AppHandle, state: &AppState) -> Result<SidecarProcess, AppError> {
    let settings = state.locked().settings.clone();
    let root = settings
        .data_root
        .ok_or_else(|| AppError::new(ErrorCode::DataRootInvalid))?;
    let layout = layout::resolve(app)?;
    let data = DataPaths::new(&root);
    let marker = bootstrap::completed_marker(&layout, &data, settings.device)
        .ok_or_else(|| AppError::with_detail(ErrorCode::Internal, "setup is not complete"))?;
    let origins = allowed_origins(app);
    let version = app.package_info().version.to_string();
    let opts = SpawnOptions {
        layout: &layout,
        data: &data,
        marker: &marker,
        app_version: &version,
        allowed_origins: &origins,
    };

    let mut process = spawn_healthy(&opts, state)?;
    state.set_status(app, AppStatus::LoadingModel, None);
    sidecar::wait_until_model_ready(&mut process, &state.shutting_down)?;
    Ok(process)
}

fn spawn_healthy(opts: &SpawnOptions, state: &AppState) -> Result<SidecarProcess, AppError> {
    let mut last_error = None;
    for _ in 0..SIDECAR_START_ATTEMPTS {
        let port = sidecar::pick_free_port()?;
        let mut process = sidecar::spawn(opts, port)?;
        match sidecar::wait_until_healthy(&mut process, &state.shutting_down) {
            Ok(()) => return Ok(process),
            // Most likely the port was taken between picking and binding: retry.
            Err(err) if err.code == ErrorCode::SidecarExited => last_error = Some(err),
            Err(err) => return Err(err),
        }
    }
    Err(last_error.unwrap_or_else(|| AppError::new(ErrorCode::SidecarExited)))
}

/// Origins allowed to call the internal API from the WebView (CORS on the sidecar).
fn allowed_origins(app: &AppHandle) -> Vec<String> {
    let mut origins: Vec<String> = [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ]
    .map(str::to_string)
    .to_vec();
    if cfg!(debug_assertions) {
        if let Some(url) = app.config().build.dev_url.as_ref() {
            origins.push(url.origin().ascii_serialization());
        }
    }
    origins
}

/// Report an unexpected sidecar exit instead of leaving the UI talking to nothing.
fn watch_sidecar(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let state = app.state::<AppState>();
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let exited = {
            let mut inner = state.locked();
            match inner.sidecar.as_mut() {
                None => return,
                Some(process) => process.exit_status(),
            }
        };
        if let Some(status) = exited {
            let process = state.locked().sidecar.take();
            drop(process);
            let err = AppError::with_detail(ErrorCode::SidecarExited, status.to_string());
            state.set_status(&app, AppStatus::Error, Some(err));
            return;
        }
    });
}

fn run_setup(app: AppHandle, settings: Settings, probe: ProbeReport) {
    let state = app.state::<AppState>();
    let result = (|| -> Result<(), AppError> {
        if probe.blocker.is_some() {
            return Err(AppError::new(ErrorCode::PlatformUnsupported));
        }
        let plan = match settings.device {
            DeviceChoice::Cpu => &probe.cpu,
            DeviceChoice::Auto => &probe.recommended,
        };
        let root = settings
            .data_root
            .clone()
            .ok_or_else(|| AppError::new(ErrorCode::DataRootInvalid))?;
        let data = DataPaths::new(&root);
        let layout = layout::resolve(&app)?;
        let reporter = Reporter::new(app.clone(), state.setup.clone(), &data.logs);
        let version = app.package_info().version.to_string();
        Bootstrap {
            layout: &layout,
            data: &data,
            plan,
            choice: settings.device,
            app_version: &version,
            reporter,
            current_child: state.setup_child.clone(),
            cancelled: state.shutting_down.clone(),
        }
        .run()
        .map(|_| ())
    })();

    let succeeded = result.is_ok();
    {
        let mut progress = lock(&state.setup);
        progress.running = false;
        progress.completed = succeeded;
        progress.error = result.err();
        let _ = app.emit(EVENT_SETUP_PROGRESS, progress.clone());
    }
    state.locked().setup_running = false;
    if succeeded && !state.shutting_down.load(Ordering::SeqCst) {
        start_sidecar(&app);
    }
}

fn inspect_path(path: &Path, required_bytes: u64) -> DataRootInfo {
    let mut issues = Vec::new();
    let exists = path.exists();
    if path.as_os_str().is_empty() || !path.is_absolute() || (exists && !path.is_dir()) {
        issues.push(ErrorCode::DataRootInvalid);
    } else if !can_create_in(path) {
        issues.push(ErrorCode::DataRootNotWritable);
    }
    let free_bytes = platform::free_space(path).ok();
    if free_bytes.is_some_and(|free| free < required_bytes) {
        issues.push(ErrorCode::DiskSpaceInsufficient);
    }
    DataRootInfo {
        path: path.display().to_string(),
        exists,
        free_bytes,
        required_bytes,
        issues,
    }
}

/// Whether directories can be created at `path` (or its nearest existing ancestor).
fn can_create_in(path: &Path) -> bool {
    // Unique per call: concurrent inspections of one folder must not collide.
    static PROBES: AtomicUsize = AtomicUsize::new(0);
    let Some(base) = path.ancestors().find(|p| p.is_dir()) else {
        return false;
    };
    let probe = base.join(format!(
        ".irodori-write-test-{}-{}",
        std::process::id(),
        PROBES.fetch_add(1, Ordering::Relaxed)
    ));
    match fs::create_dir(&probe) {
        Ok(()) => {
            let _ = fs::remove_dir(&probe);
            true
        }
        Err(_) => false,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ----- Commands ------------------------------------------------------------------------

#[tauri::command]
pub fn get_boot_state(state: State<'_, AppState>) -> BootState {
    let inner = state.locked();
    BootState {
        status: inner.status,
        error: inner.error.clone(),
        locale: inner.settings.locale.clone(),
        terms_accepted: inner.settings.terms_accepted(),
        terms_version: TERMS_VERSION,
        data_root: inner
            .settings
            .data_root
            .as_ref()
            .map(|p| p.display().to_string()),
        default_data_root: inner
            .default_data_root
            .as_ref()
            .map(|p| p.display().to_string()),
        logs_dir: inner
            .settings
            .data_root
            .as_deref()
            .map(|root| DataPaths::new(root).logs.display().to_string()),
        device_choice: inner.settings.device,
        setup: lock(&state.setup).clone(),
    }
}

#[tauri::command]
pub fn set_locale(state: State<'_, AppState>, locale: String) -> Result<(), String> {
    if !SUPPORTED_LOCALES.contains(&locale.as_str()) {
        return Err(AppError::new(ErrorCode::InvalidLocale).into());
    }
    state
        .update_settings(|s| s.locale = Some(locale))
        .map_err(Into::into)
}

#[tauri::command]
pub fn accept_terms(state: State<'_, AppState>) -> Result<(), String> {
    state
        .update_settings(|s| {
            s.terms = Some(TermsAcceptance {
                version: TERMS_VERSION,
                accepted_at: config::now_unix(),
            });
        })
        .map_err(Into::into)
}

#[tauri::command]
pub async fn probe_platform(state: State<'_, AppState>) -> Result<ProbeReport, String> {
    let cached = state.locked().probe.clone();
    if let Some(report) = cached {
        return Ok(report);
    }
    let report = tauri::async_runtime::spawn_blocking(platform::probe)
        .await
        .map_err(|e| String::from(AppError::with_detail(ErrorCode::Internal, e.to_string())))?;
    state.locked().probe = Some(report.clone());
    Ok(report)
}

#[tauri::command]
pub fn set_device_choice(state: State<'_, AppState>, choice: DeviceChoice) -> Result<(), String> {
    state
        .update_settings(|s| s.device = choice)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn inspect_data_root(
    state: State<'_, AppState>,
    path: String,
) -> Result<DataRootInfo, String> {
    let variant = plan_for(&state.locked()).map(|p| p.torch_variant);
    let required = if variant == Some(TorchVariant::Cu128) {
        REQUIRED_BYTES_CUDA
    } else {
        REQUIRED_BYTES_OTHER
    };
    tauri::async_runtime::spawn_blocking(move || inspect_path(Path::new(&path), required))
        .await
        .map_err(|e| AppError::with_detail(ErrorCode::Internal, e.to_string()).into())
}

#[tauri::command]
pub fn set_data_root(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = PathBuf::from(path.trim());
    if !root.is_absolute() {
        return Err(AppError::new(ErrorCode::DataRootInvalid).into());
    }
    fs::create_dir_all(&root).map_err(|e| {
        String::from(AppError::with_detail(
            ErrorCode::DataRootNotWritable,
            e.to_string(),
        ))
    })?;
    state
        .update_settings(|s| s.data_root = Some(root))
        .map_err(Into::into)
}

#[tauri::command]
pub async fn start_setup(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let (settings, cached_probe) = {
        let mut inner = state.locked();
        if inner.setup_running {
            return Err(AppError::new(ErrorCode::SetupAlreadyRunning).into());
        }
        if !inner.settings.terms_accepted() || inner.settings.data_root.is_none() {
            return Err(AppError::new(ErrorCode::DataRootInvalid).into());
        }
        inner.setup_running = true;
        (inner.settings.clone(), inner.probe.clone())
    };
    {
        let mut progress = lock(&state.setup);
        *progress = SetupProgress {
            running: true,
            ..SetupProgress::default()
        };
        let _ = app.emit(EVENT_SETUP_PROGRESS, progress.clone());
    }
    thread::spawn(move || {
        let probe = cached_probe.unwrap_or_else(platform::probe);
        app.state::<AppState>().locked().probe = Some(probe.clone());
        run_setup(app, settings, probe);
    });
    Ok(())
}

#[tauri::command]
pub fn get_setup_progress(state: State<'_, AppState>) -> SetupProgress {
    lock(&state.setup).clone()
}

#[tauri::command]
pub fn get_sidecar_port(state: State<'_, AppState>) -> Result<u16, String> {
    let inner = state.locked();
    match (inner.status, inner.sidecar.as_ref()) {
        (AppStatus::Ready, Some(process)) => Ok(process.port),
        _ => Err(AppError::new(ErrorCode::SidecarNotReady).into()),
    }
}

/// Start the sidecar again after an error (setup itself is retried via `start_setup`).
#[tauri::command]
pub fn retry_startup(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.locked().status != AppStatus::Error {
        return Ok(());
    }
    thread::spawn(move || start_sidecar(&app));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_rejects_relative_paths() {
        let info = inspect_path(Path::new("relative/dir"), 1);
        assert_eq!(info.issues, vec![ErrorCode::DataRootInvalid]);
    }

    #[test]
    fn inspect_accepts_a_writable_new_folder_and_checks_space() {
        let target = std::env::temp_dir().join(format!("irodori-root-{}", std::process::id()));
        let _ = fs::remove_dir_all(&target);
        let ok = inspect_path(&target, 1);
        assert!(ok.issues.is_empty(), "{:?}", ok.issues);
        assert!(!ok.exists);
        assert!(ok.free_bytes.is_some());
        // Nothing was created by the inspection itself.
        assert!(!target.exists());

        let too_big = inspect_path(&target, u64::MAX);
        assert_eq!(too_big.issues, vec![ErrorCode::DiskSpaceInsufficient]);
    }

    #[test]
    fn inspect_rejects_a_file() {
        let file = std::env::temp_dir().join(format!("irodori-file-{}", std::process::id()));
        fs::write(&file, b"x").unwrap();
        let info = inspect_path(&file, 1);
        assert!(info.issues.contains(&ErrorCode::DataRootInvalid));
        let _ = fs::remove_file(&file);
    }
}
