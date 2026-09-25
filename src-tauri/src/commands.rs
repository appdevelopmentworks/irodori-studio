//! Tauri commands, the shared application state, and the startup and setup flows.
//! Commands return `Result<T, String>` whose error is an error code the frontend
//! translates (D17). The sidecar port reaches the frontend only through
//! `get_sidecar_port` (D10).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bootstrap::{self, Bootstrap, Marker, Reporter, SetupProgress, EVENT_SETUP_PROGRESS};
use crate::config::{
    self, DeviceChoice, RuntimeOverride, Settings, TermsAcceptance, SUPPORTED_LOCALES,
    TERMS_VERSION,
};
use crate::error::{AppError, ErrorCode};
use crate::layout;
use crate::logs::{self, LogName, LogTail};
use crate::paths::{self, DataPaths};
use crate::platform::{self, Device, DevicePlan, Precision, ProbeReport, TorchVariant, TreeKiller};
use crate::relocate::{self, MovePhase, MoveProgress, MoveTarget, EVENT_MOVE};
use crate::sidecar::{self, SidecarProcess, SpawnOptions};
use crate::update_check::{self, UpdateState};

pub const EVENT_STATUS: &str = "app://status";
pub const EVENT_UPDATE: &str = "app://update";

const GB: u64 = 1_000_000_000;
/// requirements.md §4: ~15 GB (CUDA runtime ≈ 8 GB + models ≈ 4–5 GB + caches).
const REQUIRED_BYTES_CUDA: u64 = 15 * GB;
const REQUIRED_BYTES_OTHER: u64 = 8 * GB;
const SIDECAR_START_ATTEMPTS: usize = 3;
/// Let the app start before asking GitHub for a newer release (D15).
const UPDATE_CHECK_DELAY: Duration = Duration::from_secs(3);
const MOVE_EMIT_INTERVAL: Duration = Duration::from_millis(200);

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
    /// The data root is being moved; the sidecar is stopped meanwhile (D16).
    Moving,
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
    moving: Arc<Mutex<MoveProgress>>,
    /// Stops a data move: set by the user's cancel and by shutdown.
    move_cancel: Arc<AtomicBool>,
    update: Arc<Mutex<UpdateState>>,
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
        self.move_cancel.store(true, Ordering::SeqCst);
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
    // Only after the terms (which mention it) are accepted, and when not turned off.
    let check_updates = {
        let inner = state.locked();
        inner.settings.update_check && inner.settings.terms_accepted()
    };
    if check_updates {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(UPDATE_CHECK_DELAY);
            run_update_check(&app);
        });
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
    let (device, precision) = effective_runtime(&marker, settings.runtime);
    let opts = SpawnOptions {
        layout: &layout,
        data: &data,
        marker: &marker,
        app_version: &version,
        allowed_origins: &origins,
        device,
        precision,
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
    } else if !paths::can_create_in(path) {
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
    cached_probe(&state).await
}

async fn cached_probe(state: &State<'_, AppState>) -> Result<ProbeReport, String> {
    let cached = state.locked().probe.clone();
    if let Some(report) = cached {
        return Ok(report);
    }
    let report = tauri::async_runtime::spawn_blocking(platform::probe)
        .await
        .map_err(internal)?;
    state.locked().probe = Some(report.clone());
    Ok(report)
}

/// A failed background task, as the `internal` error code.
fn internal(err: impl std::fmt::Display) -> String {
    AppError::with_detail(ErrorCode::Internal, err.to_string()).into()
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

// ----- Runtime override (D9) ---------------------------------------------------------

/// Devices an override may choose, given the torch setup installed: a CUDA build also
/// runs on the CPU, the macOS wheels run on MPS or the CPU, a CPU build only on the CPU
/// (using a GPU then needs setup again).
fn runtime_devices(installed: Device) -> Vec<Device> {
    match installed {
        Device::Cuda => vec![Device::Cuda, Device::Cpu],
        Device::Mps => vec![Device::Mps, Device::Cpu],
        Device::Cpu => vec![Device::Cpu],
    }
}

fn runtime_allowed(installed: Device, runtime: RuntimeOverride, bf16: bool) -> bool {
    runtime_devices(installed).contains(&runtime.device)
        && match runtime.precision {
            Precision::Fp32 => true,
            Precision::Bf16 => runtime.device == Device::Cuda && bf16,
        }
}

/// What the sidecar runs with: the override when the installed torch allows it (bf16 was
/// checked against the GPU when it was chosen), else the setup plan.
fn effective_runtime(marker: &Marker, runtime: Option<RuntimeOverride>) -> (Device, Precision) {
    let installed = marker.device.unwrap_or(Device::Cpu);
    match runtime {
        Some(runtime) if runtime_allowed(installed, runtime, true) => {
            (runtime.device, runtime.precision)
        }
        _ => (installed, marker.precision.unwrap_or(Precision::Fp32)),
    }
}

// ----- Update check (D15) ------------------------------------------------------------

fn update_snapshot(state: &AppState) -> UpdateState {
    let mut snapshot = lock(&state.update).clone();
    snapshot.skipped_version = state.locked().settings.skipped_version.clone();
    snapshot
}

/// Ask GitHub once; a check already running is joined rather than repeated.
fn run_update_check(app: &AppHandle) -> UpdateState {
    let state = app.state::<AppState>();
    {
        let mut update = lock(&state.update);
        if update.checking {
            drop(update);
            return update_snapshot(&state);
        }
        update.checking = true;
    }
    let _ = app.emit(EVENT_UPDATE, update_snapshot(&state));
    let version = app.package_info().version.to_string();
    let result = update_check::fetch_latest(&version);
    {
        let mut update = lock(&state.update);
        update.checking = false;
        update.checked_at = Some(config::now_unix());
        match result {
            Ok(latest) => {
                update.latest = latest;
                update.error = None;
            }
            Err(err) => update.error = Some(err.code),
        }
    }
    let snapshot = update_snapshot(&state);
    let _ = app.emit(EVENT_UPDATE, snapshot.clone());
    snapshot
}

// ----- Data root move (D16) ----------------------------------------------------------

fn set_move(app: &AppHandle, state: &AppState, change: impl FnOnce(&mut MoveProgress)) {
    let snapshot = {
        let mut progress = lock(&state.moving);
        change(&mut progress);
        progress.clone()
    };
    let _ = app.emit(EVENT_MOVE, snapshot);
}

fn run_move(app: &AppHandle, from: PathBuf, to: PathBuf) {
    let state = app.state::<AppState>();
    let created = !to.exists();
    let result = move_data(app, &state, &from, &to);
    let cancelled = state.move_cancel.load(Ordering::SeqCst);
    if let Err(err) = result {
        relocate::remove_copy(&to, created);
        set_move(app, &state, |p| {
            p.phase = if cancelled {
                MovePhase::Cancelled
            } else {
                MovePhase::Failed
            };
            p.running = false;
            p.error = (!cancelled).then_some(err);
        });
        if !state.shutting_down.load(Ordering::SeqCst) {
            start_sidecar(app);
        }
        return;
    }

    set_move(app, &state, |p| p.phase = MovePhase::Starting);
    start_sidecar(app);
    if state.locked().status == AppStatus::Ready {
        set_move(app, &state, |p| {
            p.phase = MovePhase::Done;
            p.running = false;
            p.old_root = Some(from.display().to_string());
        });
        return;
    }
    // The copy did not start: back to the old folder, which was never touched.
    let reason = state.locked().error.clone();
    let _ = state.update_settings(|s| s.data_root = Some(from.clone()));
    relocate::remove_copy(&to, created);
    set_move(app, &state, |p| {
        p.phase = MovePhase::Failed;
        p.running = false;
        p.error = Some(AppError::with_detail(
            ErrorCode::DataMoveFailed,
            reason.map(|e| e.to_string()).unwrap_or_default(),
        ));
    });
    start_sidecar(app);
}

/// Stop, scan, copy, verify, relink the venv, switch. Nothing is switched on failure.
fn move_data(app: &AppHandle, state: &AppState, from: &Path, to: &Path) -> Result<(), AppError> {
    // Nothing may write to the data root while it is copied.
    let sidecar = state.locked().sidecar.take();
    drop(sidecar);
    // The killed tree releases its file handles.
    thread::sleep(Duration::from_millis(500));

    set_move(app, state, |p| p.phase = MovePhase::Scanning);
    let plan = relocate::scan(from)
        .map_err(|e| AppError::with_detail(ErrorCode::DataMoveFailed, e.to_string()))?;
    let target = relocate::check_target(from, to, plan.bytes);
    if let Some(&issue) = target.issues.first() {
        return Err(AppError::new(issue));
    }
    fs::create_dir_all(to)
        .map_err(|e| AppError::with_detail(ErrorCode::DataRootNotWritable, e.to_string()))?;

    set_move(app, state, |p| {
        p.phase = MovePhase::Copying;
        p.total_bytes = plan.bytes;
        p.total_files = plan.files;
    });
    let mut last = Instant::now();
    relocate::copy_tree(from, to, &plan, &state.move_cancel, &mut |bytes, files| {
        if last.elapsed() >= MOVE_EMIT_INTERVAL {
            last = Instant::now();
            set_move(app, state, |p| {
                p.done_bytes = bytes;
                p.done_files = files;
            });
        }
    })?;

    set_move(app, state, |p| {
        p.phase = MovePhase::Verifying;
        p.done_bytes = plan.bytes;
        p.done_files = plan.files;
    });
    relocate::verify(from, to, &plan)?;
    let data = DataPaths::new(to);
    let python = bootstrap::read_marker(&data)
        .and_then(|marker| marker.python)
        .ok_or_else(|| AppError::with_detail(ErrorCode::DataMoveFailed, "no setup marker"))?;
    relocate::relink_venv(&layout::resolve(app)?.uv, &data, &python)?;
    relocate::check_venv(&data)?;

    set_move(app, state, |p| p.phase = MovePhase::Switching);
    state.update_settings(|s| s.data_root = Some(to.to_path_buf()))
}

// ----- Settings commands (Session 9) -------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeChoices {
    /// As set up (the setup marker); `None` before setup finished.
    pub installed_device: Option<Device>,
    pub installed_precision: Option<Precision>,
    pub torch_version: Option<String>,
    /// The override saved in settings.
    pub selected: Option<RuntimeOverride>,
    pub devices: Vec<Device>,
    /// The GPU in use runs bf16 (Ampere or newer).
    pub bf16: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsInfo {
    pub app_version: String,
    pub data_root: Option<String>,
    pub logs_dir: Option<String>,
    /// Unix seconds.
    pub terms_accepted_at: Option<u64>,
    pub update_check: bool,
    pub skipped_version: Option<String>,
    pub runtime: RuntimeChoices,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderKind {
    DataRoot,
    Logs,
    Models,
    Projects,
    Exports,
}

/// Commands that stop or replace the sidecar wait until nothing else is doing so.
fn ensure_idle(state: &AppState) -> Result<(), AppError> {
    let inner = state.locked();
    let idle = !inner.setup_running
        && matches!(inner.status, AppStatus::Ready | AppStatus::Error)
        && !lock(&state.moving).running;
    if idle {
        Ok(())
    } else {
        Err(AppError::new(ErrorCode::Busy))
    }
}

fn data_root(state: &AppState) -> Result<PathBuf, AppError> {
    state
        .locked()
        .settings
        .data_root
        .clone()
        .ok_or_else(|| AppError::new(ErrorCode::DataRootInvalid))
}

#[tauri::command]
pub async fn get_settings_info(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SettingsInfo, String> {
    let settings = state.locked().settings.clone();
    let marker = settings
        .data_root
        .as_deref()
        .and_then(|root| bootstrap::read_marker(&DataPaths::new(root)));
    let installed = marker.as_ref().and_then(|m| m.device);
    let bf16 = if installed == Some(Device::Cuda) {
        let probe = cached_probe(&state).await?;
        platform::bf16_supported(&probe.nvidia, marker.as_ref().and_then(|m| m.gpu_index))
    } else {
        false
    };
    Ok(SettingsInfo {
        app_version: app.package_info().version.to_string(),
        data_root: settings.data_root.as_ref().map(|p| p.display().to_string()),
        logs_dir: settings
            .data_root
            .as_deref()
            .map(|root| DataPaths::new(root).logs.display().to_string()),
        terms_accepted_at: settings.terms.as_ref().map(|t| t.accepted_at),
        update_check: settings.update_check,
        skipped_version: settings.skipped_version.clone(),
        runtime: RuntimeChoices {
            installed_device: installed,
            installed_precision: marker.as_ref().and_then(|m| m.precision),
            torch_version: marker.as_ref().and_then(|m| m.torch_version.clone()),
            selected: settings.runtime,
            devices: installed.map(runtime_devices).unwrap_or_default(),
            bf16,
        },
    })
}

/// Save a device / precision override (`None`: as set up) and restart the sidecar.
#[tauri::command]
pub async fn set_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    runtime: Option<RuntimeOverride>,
) -> Result<(), String> {
    ensure_idle(&state)?;
    let marker = bootstrap::read_marker(&DataPaths::new(&data_root(&state)?))
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeUnsupported))?;
    let installed = marker
        .device
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeUnsupported))?;
    let runtime = match runtime {
        None => None,
        Some(chosen) => {
            let bf16 = if chosen.precision == Precision::Bf16 {
                let probe = cached_probe(&state).await?;
                platform::bf16_supported(&probe.nvidia, marker.gpu_index)
            } else {
                false
            };
            if !runtime_allowed(installed, chosen, bf16) {
                return Err(AppError::new(ErrorCode::RuntimeUnsupported).into());
            }
            // The setup plan itself needs no override.
            (chosen.device != installed || Some(chosen.precision) != marker.precision)
                .then_some(chosen)
        }
    };
    state.update_settings(|s| s.runtime = runtime)?;
    state.set_status(&app, AppStatus::Starting, None);
    thread::spawn(move || start_sidecar(&app));
    Ok(())
}

/// Start the sidecar again (a new process, the model loaded afresh) — e.g. after the GPU
/// failed during a generation.
#[tauri::command]
pub fn restart_sidecar(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    ensure_idle(&state)?;
    state.set_status(&app, AppStatus::Starting, None);
    thread::spawn(move || start_sidecar(&app));
    Ok(())
}

/// Stop the sidecar and run setup again for what a repair can fix (dependencies, model
/// files by hash, the self-check); the wizard shows it and starts the app afterwards.
#[tauri::command]
pub fn repair_installation(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    ensure_idle(&state)?;
    let root = data_root(&state)?;
    let sidecar = state.locked().sidecar.take();
    drop(sidecar);
    bootstrap::request_repair(&DataPaths::new(&root))?;
    *lock(&state.setup) = SetupProgress::default();
    state.set_status(&app, AppStatus::Setup, None);
    Ok(())
}

#[tauri::command]
pub fn open_folder(state: State<'_, AppState>, folder: FolderKind) -> Result<(), String> {
    let data = DataPaths::new(&data_root(&state)?);
    let path = match folder {
        FolderKind::DataRoot => data.root,
        FolderKind::Logs => data.logs,
        FolderKind::Models => data.models,
        FolderKind::Projects => data.projects,
        FolderKind::Exports => data.exports,
    };
    let failed = |e: std::io::Error| AppError::with_detail(ErrorCode::OpenFailed, e.to_string());
    fs::create_dir_all(&path).map_err(failed)?;
    platform::open_path(&path).map_err(failed)?;
    Ok(())
}

#[tauri::command]
pub async fn read_log(state: State<'_, AppState>, name: LogName) -> Result<LogTail, String> {
    let dir = DataPaths::new(&data_root(&state)?).logs;
    tauri::async_runtime::spawn_blocking(move || logs::read_tail(&dir, name, logs::TAIL_BYTES))
        .await
        .map_err(internal)
}

#[tauri::command]
pub fn get_update_state(state: State<'_, AppState>) -> UpdateState {
    update_snapshot(&state)
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateState, String> {
    tauri::async_runtime::spawn_blocking(move || run_update_check(&app))
        .await
        .map_err(internal)
}

#[tauri::command]
pub fn set_update_check(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state
        .update_settings(|s| s.update_check = enabled)
        .map_err(Into::into)
}

/// Stop telling the user about `version`.
#[tauri::command]
pub fn skip_update(
    app: AppHandle,
    state: State<'_, AppState>,
    version: String,
) -> Result<(), String> {
    state.update_settings(|s| s.skipped_version = Some(version))?;
    let _ = app.emit(EVENT_UPDATE, update_snapshot(&state));
    Ok(())
}

/// The Releases page of the latest version (only ever this app's Releases).
#[tauri::command]
pub fn open_release_page(state: State<'_, AppState>) -> Result<(), String> {
    let url = lock(&state.update)
        .latest
        .as_ref()
        .map(|latest| latest.url.clone())
        .filter(|url| update_check::is_release_url(url))
        .unwrap_or_else(|| update_check::RELEASES_URL.to_string());
    platform::open_url(&url)
        .map_err(|e| AppError::with_detail(ErrorCode::OpenFailed, e.to_string()).into())
}

#[tauri::command]
pub async fn inspect_move_target(
    state: State<'_, AppState>,
    path: String,
) -> Result<MoveTarget, String> {
    let current = data_root(&state)?;
    let target = PathBuf::from(path.trim());
    tauri::async_runtime::spawn_blocking(move || {
        let required = relocate::scan(&current).map_or(0, |plan| plan.bytes);
        relocate::suggest_target(&current, &target, required)
    })
    .await
    .map_err(internal)
}

/// Move the data root to `path` (an empty or new folder); progress arrives as
/// `app://move` events while the app shows the move screen.
#[tauri::command]
pub fn start_data_move(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    ensure_idle(&state)?;
    if state.locked().status != AppStatus::Ready {
        return Err(AppError::new(ErrorCode::Busy).into());
    }
    let from = data_root(&state)?;
    let to = PathBuf::from(path.trim());
    // The size is checked again after scanning.
    let target = relocate::check_target(&from, &to, 0);
    if let Some(&issue) = target.issues.first() {
        return Err(AppError::new(issue).into());
    }
    state.move_cancel.store(false, Ordering::SeqCst);
    *lock(&state.moving) = MoveProgress {
        phase: MovePhase::Stopping,
        running: true,
        from: Some(from.display().to_string()),
        to: Some(to.display().to_string()),
        ..MoveProgress::default()
    };
    state.set_status(&app, AppStatus::Moving, None);
    set_move(&app, &state, |_| {});
    thread::spawn(move || run_move(&app, from, to));
    Ok(())
}

#[tauri::command]
pub fn cancel_data_move(state: State<'_, AppState>) {
    if lock(&state.moving).running {
        state.move_cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub fn get_move_progress(state: State<'_, AppState>) -> MoveProgress {
    lock(&state.moving).clone()
}

/// Delete the folder the data root was moved away from (asked for explicitly).
#[tauri::command]
pub async fn delete_old_data_root(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let old = lock(&state.moving)
        .old_root
        .clone()
        .ok_or_else(|| AppError::new(ErrorCode::DataRootInvalid))?;
    let current = data_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        relocate::delete_old_root(Path::new(&old), &current)
    })
    .await
    .map_err(internal)??;
    set_move(&app, &state, |p| *p = MoveProgress::default());
    Ok(())
}

/// Forget a finished move's result (the old folder stays where it is).
#[tauri::command]
pub fn dismiss_move_result(app: AppHandle, state: State<'_, AppState>) {
    if !lock(&state.moving).running {
        set_move(&app, &state, |p| *p = MoveProgress::default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(device: Device, precision: Precision) -> Marker {
        Marker {
            device: Some(device),
            precision: Some(precision),
            ..Marker::default()
        }
    }

    #[test]
    fn overrides_stay_within_the_installed_torch() {
        let cuda = marker(Device::Cuda, Precision::Fp32);
        let to_cpu = RuntimeOverride {
            device: Device::Cpu,
            precision: Precision::Fp32,
        };
        assert_eq!(
            effective_runtime(&cuda, Some(to_cpu)),
            (Device::Cpu, Precision::Fp32)
        );
        let bf16 = RuntimeOverride {
            device: Device::Cuda,
            precision: Precision::Bf16,
        };
        assert_eq!(
            effective_runtime(&cuda, Some(bf16)),
            (Device::Cuda, Precision::Bf16)
        );
        assert_eq!(
            effective_runtime(&cuda, None),
            (Device::Cuda, Precision::Fp32)
        );

        // A CPU build cannot use the GPU, and bf16 is for CUDA only.
        let cpu = marker(Device::Cpu, Precision::Fp32);
        assert_eq!(
            effective_runtime(&cpu, Some(bf16)),
            (Device::Cpu, Precision::Fp32)
        );
        let cpu_bf16 = RuntimeOverride {
            device: Device::Cpu,
            precision: Precision::Bf16,
        };
        assert!(!runtime_allowed(Device::Cuda, cpu_bf16, true));
        assert!(!runtime_allowed(Device::Cuda, bf16, false));
        let mps = marker(Device::Mps, Precision::Fp32);
        assert_eq!(runtime_devices(Device::Mps), vec![Device::Mps, Device::Cpu]);
        assert_eq!(
            effective_runtime(&mps, Some(to_cpu)),
            (Device::Cpu, Precision::Fp32)
        );
    }

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
