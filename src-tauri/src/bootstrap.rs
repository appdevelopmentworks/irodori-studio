//! First-run setup (docs/architecture.md, "First-run setup"): uv-managed Python → venv
//! under the data root → locked sidecar deps (no torch) → platform torch (D2) → model
//! assets → self-check. Each finished step is recorded in the marker right away, so a
//! relaunch after an interruption skips it; the model download itself resumes
//! mid-file. Progress snapshots and log lines stream to the frontend as events.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::config::{now_unix, DeviceChoice};
use crate::error::{AppError, ErrorCode};
use crate::layout::Layout;
use crate::paths::DataPaths;
use crate::platform::{Device, DevicePlan, Precision, ProcessTree, TorchVariant, TreeKiller};

pub const EVENT_SETUP_PROGRESS: &str = "setup://progress";
pub const EVENT_SETUP_LOG: &str = "setup://log";

const MARKER_SCHEMA: u32 = 1;
const EVENT_PREFIX: &str = "IRODORI_EVENT ";
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(200);
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const ERROR_TAIL_LINES: usize = 12;

// ----- Progress model (mirrored in src/lib/types.ts) -----------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepId {
    Python,
    Venv,
    Deps,
    Torch,
    Models,
    Verify,
}

const STEPS: [StepId; 6] = [
    StepId::Python,
    StepId::Venv,
    StepId::Deps,
    StepId::Torch,
    StepId::Models,
    StepId::Verify,
];

impl StepId {
    fn as_str(self) -> &'static str {
        match self {
            StepId::Python => "python",
            StepId::Venv => "venv",
            StepId::Deps => "deps",
            StepId::Torch => "torch",
            StepId::Models => "models",
            StepId::Verify => "verify",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Pending,
    Running,
    Done,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepProgress {
    pub id: StepId,
    pub state: StepState,
    pub done_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    /// Data for the UI to format (a torch variant, a file name), never prose.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupProgress {
    pub running: bool,
    pub completed: bool,
    pub steps: Vec<StepProgress>,
    pub error: Option<AppError>,
}

impl Default for SetupProgress {
    fn default() -> Self {
        Self {
            running: false,
            completed: false,
            steps: STEPS
                .iter()
                .map(|&id| StepProgress {
                    id,
                    state: StepState::Pending,
                    done_bytes: None,
                    total_bytes: None,
                    detail: None,
                })
                .collect(),
            error: None,
        }
    }
}

impl SetupProgress {
    fn step_mut(&mut self, id: StepId) -> &mut StepProgress {
        let index = STEPS.iter().position(|&s| s == id).unwrap_or(0);
        &mut self.steps[index]
    }
}

// ----- Inputs and marker -------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TorchIndex {
    cuda: String,
    cpu: String,
}

/// `torch` section of sidecar/upstream.json (validated against upstream by a test).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TorchSpec {
    packages: Vec<String>,
    pypi_packages: Vec<String>,
    index: TorchIndex,
}

#[derive(Debug, Deserialize)]
struct UpstreamJson {
    torch: TorchSpec,
}

/// What the current app build expects to be installed; hashes detect changes.
#[derive(Debug, Clone)]
struct Inputs {
    python: String,
    deps_hash: String,
    torch: TorchSpec,
    torch_hash: String,
    models_hash: String,
}

impl Inputs {
    fn read(layout: &Layout) -> Result<Inputs, AppError> {
        let dir = &layout.sidecar_dir;
        let missing = |name: &str, e: io::Error| {
            AppError::with_detail(ErrorCode::SidecarSourceMissing, format!("{name}: {e}"))
        };
        let python = fs::read_to_string(dir.join(".python-version"))
            .map_err(|e| missing(".python-version", e))?
            .trim()
            .to_string();
        let lock = fs::read(dir.join("uv.lock")).map_err(|e| missing("uv.lock", e))?;
        let models = fs::read(dir.join("models.json")).map_err(|e| missing("models.json", e))?;
        let upstream_text = fs::read_to_string(dir.join("upstream.json"))
            .map_err(|e| missing("upstream.json", e))?;
        let upstream: UpstreamJson = serde_json::from_str(&upstream_text).map_err(|e| {
            AppError::with_detail(
                ErrorCode::SidecarSourceMissing,
                format!("upstream.json: {e}"),
            )
        })?;
        let torch_json = serde_json::to_string(&upstream.torch)
            .map_err(|e| AppError::with_detail(ErrorCode::Internal, e.to_string()))?;
        Ok(Inputs {
            python,
            deps_hash: fnv1a_hex(&lock),
            torch_hash: fnv1a_hex(torch_json.as_bytes()),
            torch: upstream.torch,
            models_hash: fnv1a_hex(&models),
        })
    }
}

/// `<data-root>/runtime/setup.json`. Every field is written as soon as its step
/// finishes; `verified_at` is set only by a passing self-check.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Marker {
    pub schema: u32,
    pub app_version: String,
    pub python: Option<String>,
    pub deps_hash: Option<String>,
    pub torch_hash: Option<String>,
    pub torch_variant: Option<TorchVariant>,
    pub torch_version: Option<String>,
    pub models_hash: Option<String>,
    pub device_choice: Option<DeviceChoice>,
    pub device: Option<Device>,
    pub precision: Option<Precision>,
    pub gpu_index: Option<u32>,
    pub verified_at: Option<u64>,
}

impl Marker {
    fn read(data: &DataPaths) -> Option<Marker> {
        let text = fs::read_to_string(data.marker()).ok()?;
        serde_json::from_str::<Marker>(&text)
            .ok()
            .filter(|m| m.schema == MARKER_SCHEMA)
    }

    fn save(&self, data: &DataPaths) -> Result<(), AppError> {
        let io_err =
            |e: io::Error| AppError::with_detail(ErrorCode::DataRootNotWritable, e.to_string());
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::with_detail(ErrorCode::Internal, e.to_string()))?;
        let tmp = data.marker().with_extension("json.tmp");
        fs::write(&tmp, text).map_err(io_err)?;
        fs::rename(&tmp, data.marker()).map_err(io_err)
    }

    fn is_complete(&self, inputs: &Inputs, choice: DeviceChoice) -> bool {
        self.python.as_deref() == Some(inputs.python.as_str())
            && self.deps_hash.as_deref() == Some(inputs.deps_hash.as_str())
            && self.torch_hash.as_deref() == Some(inputs.torch_hash.as_str())
            && self.models_hash.as_deref() == Some(inputs.models_hash.as_str())
            && self.device_choice == Some(choice)
            && self.device.is_some()
            && self.verified_at.is_some()
    }
}

/// The setup marker as last written, complete or not.
pub fn read_marker(data: &DataPaths) -> Option<Marker> {
    Marker::read(data)
}

/// Make the next setup run re-check what a repair can fix: the locked dependencies, the
/// model files (hash-verified, missing or damaged ones downloaded again) and the
/// self-check. Python, the venv and torch stay unless they are broken.
pub fn request_repair(data: &DataPaths) -> Result<(), AppError> {
    let mut marker = Marker::read(data).unwrap_or_default();
    marker.schema = MARKER_SCHEMA;
    marker.deps_hash = None;
    marker.models_hash = None;
    marker.verified_at = None;
    marker.save(data)
}

/// The marker when setup is complete for this build and device choice; `None` means
/// the wizard must run (again).
pub fn completed_marker(layout: &Layout, data: &DataPaths, choice: DeviceChoice) -> Option<Marker> {
    let marker = Marker::read(data)?;
    let inputs = Inputs::read(layout).ok()?;
    (marker.is_complete(&inputs, choice) && data.venv_python().is_file()).then_some(marker)
}

// ----- Reporter ------------------------------------------------------------------------

/// Shares the progress snapshot with `AppState`, emits it to the frontend (throttled
/// for byte progress), and appends log lines to `<logs>/setup.log`.
#[derive(Clone)]
pub struct Reporter {
    app: AppHandle,
    progress: Arc<Mutex<SetupProgress>>,
    log_file: Arc<Mutex<Option<File>>>,
    last_emit: Arc<Mutex<Option<Instant>>>,
}

impl Reporter {
    pub fn new(app: AppHandle, progress: Arc<Mutex<SetupProgress>>, logs_dir: &Path) -> Self {
        let log_path = logs_dir.join("setup.log");
        rotate_log(&log_path);
        let log_file = fs::create_dir_all(logs_dir)
            .and_then(|()| OpenOptions::new().create(true).append(true).open(&log_path))
            .ok();
        Self {
            app,
            progress,
            log_file: Arc::new(Mutex::new(log_file)),
            last_emit: Arc::new(Mutex::new(None)),
        }
    }

    pub fn update(&self, force: bool, change: impl FnOnce(&mut SetupProgress)) {
        let snapshot = {
            let mut progress = lock(&self.progress);
            change(&mut progress);
            progress.clone()
        };
        let mut last = lock(&self.last_emit);
        let due = last.is_none_or(|t| t.elapsed() >= PROGRESS_EMIT_INTERVAL);
        if force || due {
            *last = Some(Instant::now());
            let _ = self.app.emit(EVENT_SETUP_PROGRESS, snapshot);
        }
    }

    fn step(&self, id: StepId, state: StepState) {
        self.update(true, |p| p.step_mut(id).state = state);
    }

    pub fn log(&self, step: Option<StepId>, line: &str) {
        let line = match step {
            Some(step) => format!("[{}] {line}", step.as_str()),
            None => line.to_string(),
        };
        if let Some(file) = lock(&self.log_file).as_mut() {
            let _ = writeln!(file, "{line}");
        }
        let _ = self.app.emit(EVENT_SETUP_LOG, line);
    }
}

// ----- Runner --------------------------------------------------------------------------

pub struct Bootstrap<'a> {
    pub layout: &'a Layout,
    pub data: &'a DataPaths,
    pub plan: &'a DevicePlan,
    pub choice: DeviceChoice,
    pub app_version: &'a str,
    pub reporter: Reporter,
    /// The child currently running, so shutdown can kill it from another thread.
    pub current_child: Arc<Mutex<Option<TreeKiller>>>,
    pub cancelled: Arc<AtomicBool>,
}

impl Bootstrap<'_> {
    pub fn run(&self) -> Result<Marker, AppError> {
        let inputs = Inputs::read(self.layout)?;
        self.data
            .ensure()
            .map_err(|e| AppError::with_detail(ErrorCode::DataRootNotWritable, e.to_string()))?;
        let mut marker = Marker::read(self.data).unwrap_or_default();
        marker.schema = MARKER_SCHEMA;
        marker.app_version = self.app_version.to_string();
        marker.verified_at = None;
        marker.save(self.data)?;
        self.reporter.log(
            None,
            &format!(
                "setup: device={} variant={:?} layout={} data_root={}",
                self.plan.device.as_str(),
                self.plan.torch_variant,
                if self.layout.installed {
                    "installed"
                } else {
                    "dev"
                },
                self.data.root.display()
            ),
        );

        // 1–2. Managed Python and the runtime venv (rebuilt when missing or broken).
        if marker.python.as_deref() == Some(inputs.python.as_str()) && self.venv_works() {
            self.skip(StepId::Python);
            self.skip(StepId::Venv);
        } else {
            marker.python = None;
            marker.deps_hash = None;
            marker.torch_hash = None;
            marker.torch_variant = None;
            marker.save(self.data)?;
            self.run_step(StepId::Python, Some(inputs.python.as_str()), || {
                self.install_python(&inputs)
            })?;
            self.run_step(StepId::Venv, None, || self.create_venv(&inputs))?;
            marker.python = Some(inputs.python.clone());
            marker.save(self.data)?;
        }

        // 3. Locked sidecar dependencies, never torch (D2).
        if marker.deps_hash.as_deref() == Some(inputs.deps_hash.as_str()) {
            self.skip(StepId::Deps);
        } else {
            self.run_step(StepId::Deps, None, || self.sync_deps())?;
            marker.deps_hash = Some(inputs.deps_hash.clone());
            marker.save(self.data)?;
        }

        // 4. torch for this platform (D2).
        let variant = self.plan.torch_variant;
        if marker.torch_hash.as_deref() == Some(inputs.torch_hash.as_str())
            && marker.torch_variant == Some(variant)
        {
            self.skip(StepId::Torch);
        } else {
            let detail = format!("{variant:?}").to_lowercase();
            self.run_step(StepId::Torch, Some(detail.as_str()), || {
                self.install_torch(&inputs.torch)
            })?;
            marker.torch_hash = Some(inputs.torch_hash.clone());
            marker.torch_variant = Some(variant);
            marker.save(self.data)?;
        }

        // 5. Model, codec, tokenizer and SilentCipher assets (resumable).
        if marker.models_hash.as_deref() == Some(inputs.models_hash.as_str()) {
            self.skip(StepId::Models);
        } else {
            self.run_step(StepId::Models, None, || self.download_models())?;
            marker.models_hash = Some(inputs.models_hash.clone());
            marker.save(self.data)?;
        }

        // 6. Self-check: torch on the chosen device + the upstream import (always).
        let mut torch_version = None;
        self.run_step(StepId::Verify, None, || {
            torch_version = self.selfcheck()?;
            Ok(())
        })?;
        marker.torch_version = torch_version;
        marker.device_choice = Some(self.choice);
        marker.device = Some(self.plan.device);
        marker.precision = Some(self.plan.precision);
        marker.gpu_index = self.plan.gpu_index;
        marker.verified_at = Some(now_unix());
        marker.save(self.data)?;
        self.reporter.log(None, "setup: complete");
        Ok(marker)
    }

    fn skip(&self, id: StepId) {
        self.reporter.step(id, StepState::Skipped);
    }

    fn run_step(
        &self,
        id: StepId,
        detail: Option<&str>,
        body: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(AppError::with_detail(ErrorCode::Internal, "cancelled"));
        }
        self.reporter.update(true, |p| {
            let step = p.step_mut(id);
            step.state = StepState::Running;
            step.detail = detail.map(str::to_string);
        });
        match body() {
            Ok(()) => {
                self.reporter.step(id, StepState::Done);
                Ok(())
            }
            Err(err) => {
                self.reporter.log(Some(id), &format!("failed: {err}"));
                self.reporter.step(id, StepState::Failed);
                Err(err)
            }
        }
    }

    // --- steps ---

    fn install_python(&self, inputs: &Inputs) -> Result<(), AppError> {
        let mut args = vec!["python", "install", inputs.python.as_str(), "--no-bin"];
        if cfg!(windows) {
            // Keep the app's private Python out of the registry and the `py` launcher.
            args.push("--no-registry");
        }
        args.push("--no-config");
        self.run_tool(
            StepId::Python,
            &self.layout.uv,
            &os_args(&args),
            &[],
            &self.data.runtime,
            ErrorCode::PythonInstallFailed,
            &mut |_| {},
        )
    }

    fn create_venv(&self, inputs: &Inputs) -> Result<(), AppError> {
        let mut args = os_args(&["venv"]);
        args.push(self.data.venv.clone().into_os_string());
        args.extend(os_args(&[
            "--python",
            inputs.python.as_str(),
            "--managed-python",
            "--clear",
            "--no-config",
        ]));
        self.run_tool(
            StepId::Venv,
            &self.layout.uv,
            &args,
            &[],
            &self.data.runtime,
            ErrorCode::VenvFailed,
            &mut |_| {},
        )
    }

    fn sync_deps(&self) -> Result<(), AppError> {
        let mut args = os_args(&["sync", "--frozen", "--no-dev", "--inexact", "--project"]);
        args.push(self.layout.sidecar_dir.clone().into_os_string());
        self.run_tool(
            StepId::Deps,
            &self.layout.uv,
            &args,
            &[(
                "UV_PROJECT_ENVIRONMENT",
                self.data.venv.clone().into_os_string(),
            )],
            &self.layout.sidecar_dir,
            ErrorCode::DepsInstallFailed,
            &mut |_| {},
        )
    }

    fn install_torch(&self, spec: &TorchSpec) -> Result<(), AppError> {
        let pip_args = |packages: &[String]| {
            let mut args = os_args(&["pip", "install", "--no-config", "--python"]);
            args.push(self.data.venv_python().into_os_string());
            // Switching CPU <-> CUDA keeps the same version number; force the swap.
            args.extend(os_args(&[
                "--reinstall-package",
                "torch",
                "--reinstall-package",
                "torchaudio",
            ]));
            args.extend(packages.iter().map(OsString::from));
            args
        };
        let index = match self.plan.torch_variant {
            TorchVariant::Cu128 => Some(spec.index.cuda.as_str()),
            TorchVariant::Cpu => Some(spec.index.cpu.as_str()),
            TorchVariant::Pypi => None,
        };
        let mut runs = Vec::new();
        match index {
            // torch + torchaudio from the PyTorch index; torchcodec has no Windows wheel
            // there, so it comes from PyPI in a second call (as upstream resolves it).
            Some(url) => {
                let mut args = pip_args(&spec.packages);
                args.extend(os_args(&["--default-index", url]));
                runs.push(args);
                let mut pypi = os_args(&["pip", "install", "--no-config", "--python"]);
                pypi.push(self.data.venv_python().into_os_string());
                pypi.extend(spec.pypi_packages.iter().map(OsString::from));
                runs.push(pypi);
            }
            None => {
                let all: Vec<String> = spec
                    .packages
                    .iter()
                    .chain(&spec.pypi_packages)
                    .cloned()
                    .collect();
                runs.push(pip_args(&all));
            }
        }
        for args in runs {
            self.run_tool(
                StepId::Torch,
                &self.layout.uv,
                &args,
                &[],
                &self.data.runtime,
                ErrorCode::TorchInstallFailed,
                &mut |_| {},
            )?;
        }
        Ok(())
    }

    fn download_models(&self) -> Result<(), AppError> {
        let mut failure: Option<AppError> = None;
        let reporter = self.reporter.clone();
        let result = self.run_tool(
            StepId::Models,
            &self.data.venv_python(),
            &os_args(&["-m", "app.provision.download"]),
            &self.python_env(false),
            &self.data.runtime,
            ErrorCode::DownloadFailed,
            &mut |event| match event["event"].as_str() {
                Some("plan") | Some("progress") => {
                    let done = event["done"].as_u64().or_else(|| {
                        let total = event["total"].as_u64()?;
                        Some(total - event["remaining"].as_u64().unwrap_or(total))
                    });
                    let total = event["total"].as_u64();
                    let file = event["file"].as_str().map(str::to_string);
                    reporter.update(false, |p| {
                        let step = p.step_mut(StepId::Models);
                        step.done_bytes = done;
                        step.total_bytes = total;
                        step.detail = file;
                    });
                }
                Some("error") => {
                    let code = match event["code"].as_str() {
                        Some("network_error") => ErrorCode::NetworkError,
                        Some("disk_space_insufficient") => ErrorCode::DiskSpaceInsufficient,
                        _ => ErrorCode::DownloadFailed,
                    };
                    let detail = event["detail"]
                        .as_str()
                        .map_or_else(|| event.to_string(), str::to_string);
                    failure = Some(AppError::with_detail(code, detail));
                }
                _ => {}
            },
        );
        match (result, failure) {
            (Err(_), Some(reported)) => Err(reported),
            (result, _) => result,
        }
    }

    /// Returns the installed torch version.
    fn selfcheck(&self) -> Result<Option<String>, AppError> {
        let mut report: Option<Value> = None;
        let result = self.run_tool(
            StepId::Verify,
            &self.data.venv_python(),
            &os_args(&[
                "-m",
                "app.provision.selfcheck",
                "--device",
                self.plan.device.as_str(),
            ]),
            &self.python_env(true),
            &self.data.runtime,
            ErrorCode::SelfcheckFailed,
            &mut |event| {
                if event["event"] == "selfcheck" {
                    report = Some(event.clone());
                }
            },
        );
        let torch_version = report
            .as_ref()
            .and_then(|r| r["torch"]["version"].as_str())
            .map(str::to_string);
        match (result, report) {
            (Ok(()), _) => Ok(torch_version),
            (Err(err), Some(report)) => {
                let issues: Vec<&str> = report["issues"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let code = if issues.iter().any(|i| i.starts_with("cuda")) {
                    ErrorCode::CudaUnavailable
                } else if issues.iter().any(|i| i.starts_with("mps")) {
                    ErrorCode::MpsUnavailable
                } else {
                    err.code
                };
                Err(AppError::with_detail(code, report.to_string()))
            }
            (Err(err), None) => Err(err),
        }
    }

    fn venv_works(&self) -> bool {
        let python = self.data.venv_python();
        if !python.is_file() {
            return false;
        }
        let mut cmd = Command::new(&python);
        cmd.args(["-c", "import sys"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        sanitize_env(&mut cmd);
        ProcessTree::spawn(cmd)
            .and_then(|mut tree| tree.wait())
            .is_ok_and(|status| status.success())
    }

    // --- process plumbing ---

    fn python_env(&self, with_upstream: bool) -> Vec<(&'static str, OsString)> {
        let mut python_path = vec![self.layout.sidecar_dir.clone()];
        if with_upstream && self.layout.upstream_dir != self.layout.sidecar_dir {
            python_path.push(self.layout.upstream_dir.clone());
        }
        let mut env = vec![
            ("HF_HOME", self.data.models.clone().into_os_string()),
            ("HF_HUB_DISABLE_TELEMETRY", "1".into()),
            ("HF_HUB_DISABLE_SYMLINKS_WARNING", "1".into()),
            (
                "PYTHONPYCACHEPREFIX",
                self.data.pycache.clone().into_os_string(),
            ),
        ];
        if let Ok(joined) = std::env::join_paths(python_path) {
            env.push(("PYTHONPATH", joined));
        }
        if with_upstream {
            // The self-check must work from the cache alone, like the sidecar will.
            env.push(("HF_HUB_OFFLINE", "1".into()));
            if let Some(index) = self.plan.gpu_index {
                env.push(("CUDA_DEVICE_ORDER", "PCI_BUS_ID".into()));
                env.push(("CUDA_VISIBLE_DEVICES", index.to_string().into()));
            }
            if cfg!(target_os = "macos") {
                env.push(("PYTORCH_ENABLE_MPS_FALLBACK", "1".into()));
            }
        }
        env
    }

    #[allow(clippy::too_many_arguments)]
    fn run_tool(
        &self,
        step: StepId,
        program: &Path,
        args: &[OsString],
        envs: &[(&'static str, OsString)],
        cwd: &Path,
        failure_code: ErrorCode,
        on_event: &mut dyn FnMut(&Value),
    ) -> Result<(), AppError> {
        let name = program
            .file_stem()
            .map_or_else(|| "tool".to_string(), |s| s.to_string_lossy().into_owned());
        let shown: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        self.reporter
            .log(Some(step), &format!("$ {name} {}", shown.join(" ")));

        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sanitize_env(&mut cmd);
        cmd.env("NO_COLOR", "1")
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            // Python tools exit with the app (app/lifecycle.py); uv ignores it.
            .env("IRODORI_PARENT_PID", std::process::id().to_string())
            .env("UV_CACHE_DIR", &self.data.uv_cache)
            .env("UV_PYTHON_INSTALL_DIR", &self.data.python);
        for (key, value) in envs {
            cmd.env(key, value);
        }

        let spawn_err = |e: io::Error| AppError::with_detail(failure_code, format!("{name}: {e}"));
        let mut tree = ProcessTree::spawn(cmd).map_err(spawn_err)?;
        *lock(&self.current_child) = Some(tree.killer());
        let stdout = tree.child().stdout.take();
        let stderr = tree.child().stderr.take();

        let err_reporter = self.reporter.clone();
        let stderr_thread = stderr.map(|pipe| {
            thread::spawn(move || {
                let mut tail = VecDeque::new();
                for_each_line(pipe, |line| {
                    err_reporter.log(Some(step), &line);
                    push_tail(&mut tail, line);
                });
                tail
            })
        });

        let mut tail = VecDeque::new();
        if let Some(pipe) = stdout {
            for_each_line(pipe, |line| match parse_event(&line) {
                Some(event) => {
                    if event["event"] != "progress" {
                        self.reporter.log(Some(step), &line);
                    }
                    on_event(&event);
                }
                None => {
                    self.reporter.log(Some(step), &line);
                    push_tail(&mut tail, line);
                }
            });
        }
        if let Some(handle) = stderr_thread {
            if let Ok(err_tail) = handle.join() {
                for line in err_tail {
                    push_tail(&mut tail, line);
                }
            }
        }
        let status = tree.wait().map_err(spawn_err)?;
        *lock(&self.current_child) = None;

        if status.success() {
            Ok(())
        } else {
            let lines: Vec<String> = tail.into_iter().collect();
            Err(AppError::with_detail(
                failure_code,
                format!("{name} exited with {status}\n{}", lines.join("\n")),
            ))
        }
    }
}

// ----- Helpers -------------------------------------------------------------------------

/// Remove inherited variables that would redirect uv or Python away from the app's
/// own runtime (a user's global UV_INDEX_URL, PYTHONHOME, a relocated HF cache, ...).
pub fn sanitize_env(cmd: &mut Command) {
    const REMOVE: [&str; 7] = [
        "PYTHONHOME",
        "PYTHONPATH",
        "VIRTUAL_ENV",
        "CONDA_PREFIX",
        "HF_HUB_CACHE",
        "HUGGINGFACE_HUB_CACHE",
        "TRANSFORMERS_CACHE",
    ];
    for (key, _) in std::env::vars_os() {
        let key_str = key.to_string_lossy();
        if key_str.starts_with("UV_") || REMOVE.contains(&key_str.as_ref()) {
            cmd.env_remove(&key);
        }
    }
}

fn os_args(args: &[&str]) -> Vec<OsString> {
    args.iter().map(OsString::from).collect()
}

fn parse_event(line: &str) -> Option<Value> {
    serde_json::from_str(line.strip_prefix(EVENT_PREFIX)?).ok()
}

/// Line reader tolerant of non-UTF-8 output (lossy), so logging never stops early.
fn for_each_line(reader: impl Read, mut f: impl FnMut(String)) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\r', '\n']);
                if !line.is_empty() {
                    f(line.to_string());
                }
            }
        }
    }
}

fn push_tail(tail: &mut VecDeque<String>, line: String) {
    if tail.len() == ERROR_TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(line);
}

fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn rotate_log(path: &Path) {
    if fs::metadata(path).is_ok_and(|m| m.len() > LOG_ROTATE_BYTES) {
        let _ = fs::rename(path, path.with_extension("1.log"));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> Inputs {
        Inputs {
            python: "3.10".into(),
            deps_hash: "d".into(),
            torch: TorchSpec {
                packages: vec![],
                pypi_packages: vec![],
                index: TorchIndex {
                    cuda: String::new(),
                    cpu: String::new(),
                },
            },
            torch_hash: "t".into(),
            models_hash: "m".into(),
        }
    }

    fn complete_marker() -> Marker {
        Marker {
            schema: MARKER_SCHEMA,
            app_version: "0.1.0".into(),
            python: Some("3.10".into()),
            deps_hash: Some("d".into()),
            torch_hash: Some("t".into()),
            torch_variant: Some(TorchVariant::Cu128),
            torch_version: Some("2.10.0+cu128".into()),
            models_hash: Some("m".into()),
            device_choice: Some(DeviceChoice::Auto),
            device: Some(Device::Cuda),
            precision: Some(Precision::Fp32),
            gpu_index: None,
            verified_at: Some(1),
        }
    }

    #[test]
    fn marker_completeness_tracks_every_input() {
        let inputs = inputs();
        let marker = complete_marker();
        assert!(marker.is_complete(&inputs, DeviceChoice::Auto));
        // Switching to CPU mode requires setup again (different torch wheels).
        assert!(!marker.is_complete(&inputs, DeviceChoice::Cpu));

        let changed_lock = Inputs {
            deps_hash: "d2".into(),
            ..inputs.clone()
        };
        assert!(!marker.is_complete(&changed_lock, DeviceChoice::Auto));

        let unverified = Marker {
            verified_at: None,
            ..complete_marker()
        };
        assert!(!unverified.is_complete(&inputs, DeviceChoice::Auto));
    }

    #[test]
    fn marker_round_trips_and_tolerates_missing_fields() {
        let text = serde_json::to_string(&complete_marker()).unwrap();
        assert_eq!(
            serde_json::from_str::<Marker>(&text).unwrap(),
            complete_marker()
        );
        let partial: Marker = serde_json::from_str(r#"{"schema":1,"python":"3.10"}"#).unwrap();
        assert_eq!(partial.python.as_deref(), Some("3.10"));
        assert_eq!(partial.verified_at, None);
    }

    #[test]
    fn parses_only_prefixed_event_lines() {
        let event =
            parse_event(r#"IRODORI_EVENT {"event":"progress","done":5,"total":10}"#).unwrap();
        assert_eq!(event["done"], 5);
        assert!(parse_event(r#"{"event":"progress"}"#).is_none());
        assert!(parse_event("IRODORI_EVENT not json").is_none());
    }

    #[test]
    fn line_reader_is_lossy_and_strips_line_endings() {
        let mut lines = Vec::new();
        for_each_line(&b"one\r\ntwo \xff\n\nthree"[..], |l| lines.push(l));
        assert_eq!(lines, vec!["one", "two \u{fffd}", "three"]);
    }

    #[test]
    fn fnv_is_stable() {
        assert_eq!(fnv1a_hex(b""), "cbf29ce484222325");
        assert_eq!(fnv1a_hex(b"a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn progress_starts_with_every_step_pending() {
        let progress = SetupProgress::default();
        let ids: Vec<StepId> = progress.steps.iter().map(|s| s.id).collect();
        assert_eq!(ids, STEPS.to_vec());
        assert!(progress.steps.iter().all(|s| s.state == StepState::Pending));
    }
}
