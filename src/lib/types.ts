// Shared types. The HTTP section mirrors docs/api-spec.md and sidecar/app/schemas.py
// (keep all three in sync in the same change). The IPC section mirrors the Rust
// structs serialized by src-tauri (commands.rs, bootstrap.rs, platform/policy.rs).

// ---- HTTP contract (docs/api-spec.md) -------------------------------------------------

export type Device = 'cuda' | 'mps' | 'cpu';
export type Precision = 'fp32' | 'bf16';

export interface ErrorResponse {
  code: string;
  message: string;
  detail: Record<string, unknown>;
}

export interface HealthResponse {
  status: 'ok';
}

export interface TorchInfo {
  version: string;
  cuda_version: string | null;
  cuda_available: boolean;
  mps_available: boolean;
}

export interface DeviceInfo {
  kind: Device;
  precision: Precision;
  available: boolean;
  name: string | null;
  compute_capability: string | null;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
}

export type SystemIssue = 'torch_unavailable' | 'cuda_unavailable' | 'mps_unavailable';

export interface SystemInfo {
  app_version: string;
  python_version: string;
  platform: 'windows' | 'macos' | 'linux' | 'other';
  device: DeviceInfo;
  torch: TorchInfo | null;
  upstream_commit: string | null;
  active_model: string | null;
  queue_length: number;
  watermark_available: boolean | null;
  issues: SystemIssue[];
}

// ---- Tauri IPC (mirrors src-tauri) ----------------------------------------------------

export type ErrorCode =
  | 'internal'
  | 'settings_io'
  | 'invalid_locale'
  | 'platform_unsupported'
  | 'data_root_invalid'
  | 'data_root_not_writable'
  | 'disk_space_insufficient'
  | 'setup_already_running'
  | 'sidecar_source_missing'
  | 'uv_missing'
  | 'python_install_failed'
  | 'venv_failed'
  | 'deps_install_failed'
  | 'torch_install_failed'
  | 'network_error'
  | 'download_failed'
  | 'selfcheck_failed'
  | 'cuda_unavailable'
  | 'mps_unavailable'
  | 'sidecar_spawn_failed'
  | 'sidecar_exited'
  | 'sidecar_health_timeout'
  | 'sidecar_not_ready';

export interface AppError {
  code: ErrorCode;
  detail: string | null;
}

export type AppStatus = 'setup' | 'starting' | 'ready' | 'error';

export interface StatusPayload {
  status: AppStatus;
  error: AppError | null;
}

export type DeviceChoice = 'auto' | 'cpu';

export type StepId = 'python' | 'venv' | 'deps' | 'torch' | 'models' | 'verify';
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface StepProgress {
  id: StepId;
  state: StepState;
  done_bytes: number | null;
  total_bytes: number | null;
  /** Data, not prose: a torch variant for `torch`, the current file for `models`. */
  detail: string | null;
}

export interface SetupProgress {
  running: boolean;
  completed: boolean;
  steps: StepProgress[];
  error: AppError | null;
}

export interface BootState {
  status: AppStatus;
  error: AppError | null;
  locale: string | null;
  terms_accepted: boolean;
  terms_version: number;
  data_root: string | null;
  default_data_root: string | null;
  logs_dir: string | null;
  device_choice: DeviceChoice;
  setup: SetupProgress;
}

export type TorchVariant = 'cu128' | 'cpu' | 'pypi';

export type Notice =
  | 'cpu_mode_slow'
  | 'no_nvidia_gpu'
  | 'gpu_too_old'
  | 'vram_too_low'
  | 'low_vram_bf16'
  | 'low_vram_fp32'
  | 'driver_update_recommended'
  | 'm1_unsupported'
  | 'low_memory'
  | 'macos_old';

export type Blocker = 'intel_mac' | 'unsupported_os';

export interface DevicePlan {
  device: Device;
  precision: Precision;
  torch_variant: TorchVariant;
  gpu_index: number | null;
  notices: Notice[];
}

export interface NvidiaGpu {
  index: number;
  name: string;
  compute_capability: string;
  vram_mib: number;
  driver_version: string;
}

export interface AppleSilicon {
  chip: string;
  arm64: boolean;
  memory_bytes: number;
  macos_version: string;
}

export interface ProbeReport {
  os: 'windows' | 'macos' | 'other';
  nvidia: NvidiaGpu[];
  apple: AppleSilicon | null;
  blocker: Blocker | null;
  recommended: DevicePlan;
  cpu: DevicePlan;
}

export interface DataRootInfo {
  path: string;
  exists: boolean;
  free_bytes: number | null;
  required_bytes: number;
  issues: ErrorCode[];
}
