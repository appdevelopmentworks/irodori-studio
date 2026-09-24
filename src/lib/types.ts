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

/** Stable error codes of the sidecar (sidecar/app/errors.py). */
export type SidecarErrorCode =
  | 'internal_error'
  | 'torch_unavailable'
  | 'cuda_unavailable'
  | 'mps_unavailable'
  | 'watermark_unavailable'
  | 'model_load_failed'
  | 'model_files_missing'
  | 'model_not_loaded'
  | 'upstream_incompatible'
  | 'upstream_unavailable'
  | 'invalid_request'
  | 'invalid_params'
  | 'text_empty'
  | 'text_too_long'
  | 'caption_unsupported'
  | 'reference_unsupported'
  | 'lora_unsupported'
  | 'lora_not_found'
  | 'lora_incompatible_with_compile'
  | 'embedding_not_found'
  | 'voice_not_found'
  | 'clip_not_found'
  | 'clip_format_unsupported'
  | 'clip_decode_failed'
  | 'clip_empty'
  | 'clip_too_short'
  | 'clip_too_long'
  | 'clip_too_large'
  | 'job_not_found'
  | 'audio_not_found'
  | 'history_not_found'
  | 'synthesis_failed'
  | 'out_of_memory'
  | 'save_path_invalid'
  | 'save_failed'
  | 'ffmpeg_unavailable';

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

/** Runtime options of the resident model; changing them needs a reload (D4). */
export interface RuntimeInfo {
  device: Device;
  model_precision: Precision;
  codec_device: Device;
  codec_precision: Precision;
  compile_model: boolean;
  compile_dynamic: boolean;
}

export interface EngineStatus {
  state: EngineState;
  model_id: string | null;
  error_code: string | null;
  runtime: RuntimeInfo | null;
}

export interface HealthResponse {
  status: 'ok';
  engine: EngineStatus;
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

export type SystemIssue =
  | 'torch_unavailable'
  | 'cuda_unavailable'
  | 'mps_unavailable'
  | 'watermark_unavailable'
  | 'model_load_failed';

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
  /** ffmpeg is available: other audio formats can be read and saved (D20). */
  ffmpeg_available: boolean;
  issues: SystemIssue[];
}

// Models, capabilities and the parameter schema (D5, D26).

export interface Capabilities {
  caption: boolean;
  speaker_reference: boolean;
  speaker_embedding: boolean;
  lora: boolean;
  duration_predictor: boolean;
  max_ref_seconds: number;
  max_output_seconds: number;
  sampling: 'rf' | 'meanflow';
  ignores: string[];
}

export interface ModelInfo {
  id: string;
  display_name: string;
  tier: string;
  size_bytes_approx: number;
  installed: boolean;
  active: boolean;
  capabilities: Capabilities;
}

export type ParamGroup = 'sampling' | 'duration' | 'cfg' | 'speaker' | 'reference' | 'advanced';

export interface ParamSchema {
  name: keyof SamplingParams;
  type: 'int' | 'float' | 'bool' | 'enum';
  default: number | boolean | string | null;
  nullable: boolean;
  min: number | null;
  max: number | null;
  step: number | null;
  choices: string[] | null;
  group: ParamGroup;
  tier: 'simple' | 'advanced';
  /** Visible when every key's current value is listed; key "reference" = reference kind. */
  visible_when: Record<string, (string | boolean)[]> | null;
}

export interface Limits {
  max_candidates: number;
  max_text_chars: number;
  max_caption_chars: number;
  max_clips: number;
  max_clip_seconds: number;
  max_upload_bytes: number;
}

export interface ModelCapabilities {
  model_id: string;
  display_name: string;
  capabilities: Capabilities;
  params: ParamSchema[];
  limits: Limits;
}

export interface EmojiItem {
  symbol: string;
  /** Stable i18n id (`emoji.<key>`) derived from the code points. */
  key: string;
  label_ja: string;
  description_ja: string;
}

// Generation.

export type ReferenceInput =
  | { kind: 'none' }
  | { kind: 'voice'; voice_id: string }
  | { kind: 'clips'; clip_ids: string[] }
  | { kind: 'embedding'; path: string };

/** All optional: omitted = capability default; `null` = auto/off where nullable. */
export interface SamplingParams {
  num_steps?: number;
  num_candidates?: number;
  seed?: number | null;
  t_schedule_mode?: 'linear' | 'sway';
  sway_coeff?: number;
  truncation_factor?: number | null;
  rescale_k?: number | null;
  rescale_sigma?: number | null;
  context_kv_cache?: boolean;
  seconds?: number | null;
  duration_scale?: number;
  cfg_guidance_mode?: 'independent' | 'joint' | 'alternating';
  cfg_scale_text?: number;
  cfg_scale_caption?: number;
  cfg_scale_speaker?: number;
  cfg_scale?: number | null;
  cfg_min_t?: number;
  cfg_max_t?: number;
  speaker_kv_scale?: number | null;
  speaker_kv_min_t?: number | null;
  speaker_kv_max_layers?: number | null;
  speaker_uncond_mode?: 'mask' | 'noise';
  ref_normalize_db?: number | null;
  ref_ensure_max?: boolean;
  max_ref_seconds?: number | null;
  max_text_len?: number | null;
  max_caption_len?: number | null;
  decode_mode?: 'sequential' | 'batch';
  trim_tail?: boolean;
  tail_window_size?: number;
  tail_std_threshold?: number;
  tail_mean_threshold?: number;
}

export interface SynthesisRequest {
  text: string;
  caption?: string | null;
  reference?: ReferenceInput;
  lora_adapter?: string | null;
  params?: SamplingParams;
  apply_dictionary?: boolean;
}

export interface JobAccepted {
  job_id: string;
  queue_position: number;
}

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AudioOutput {
  index: number;
  audio_id: string;
  duration_s: number;
}

/** Milliseconds per stage (upstream stage names plus encode_reference, write_audio). */
export type Timings = Record<string, number>;

export interface TtsResult {
  history_id: string;
  used_seed: number;
  timings: Timings;
  outputs: AudioOutput[];
  watermarked: boolean;
}

export interface JobError {
  code: string;
  message: string;
}

export interface JobInfo {
  job_id: string;
  kind: 'tts';
  state: JobState;
  queue_position: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: JobError | null;
  result: TtsResult | null;
}

export interface CancelResponse {
  job_id: string;
  state: 'cancelled' | 'cancelling' | 'completed' | 'failed';
}

export interface QueueItem {
  job_id: string;
  kind: 'tts';
  source: 'ui' | 'api';
  state: 'queued' | 'running';
  created_at: string;
}

export interface QueueSnapshot {
  running: QueueItem | null;
  queued: QueueItem[];
}

/** `GET /jobs/{id}/events` (SSE); the event name is `type`. */
export type JobEvent =
  | { type: 'queued'; data: { position: number } }
  | { type: 'started'; data: Record<string, never> }
  | { type: 'log'; data: { line: string } }
  | { type: 'progress'; data: { done: number; total: number; unit: 'step' | 'candidate' | 'chunk' | 'line' } }
  | { type: 'candidate'; data: AudioOutput }
  | { type: 'completed'; data: TtsResult }
  | { type: 'failed'; data: JobError }
  | { type: 'cancelled'; data: Record<string, never> };

export type JobEventType = JobEvent['type'];

// Clips, history, preferences.

export interface ClipInfo {
  clip_id: string;
  filename: string;
  duration_s: number;
  sample_rate: number;
  channels: number;
  created_at: string;
}

export interface HistorySummary {
  id: string;
  created_at: string;
  model_id: string;
  text: string;
  caption: string | null;
  reference_kind: ReferenceInput['kind'];
  used_seed: number;
  watermarked: boolean;
  outputs: AudioOutput[];
  /** The candidate the user adopted, if any. */
  adopted_audio_id: string | null;
}

export interface HistoryPatch {
  adopted_audio_id: string | null;
}

export type AudioFormat = 'wav' | 'mp3' | 'm4a' | 'flac' | 'opus';

export interface SavedFile {
  path: string;
  bytes: number;
  format: AudioFormat;
}

export interface HistoryEntry extends HistorySummary {
  /** The request as submitted (unset fields absent). */
  request: SynthesisRequest;
  /** Every resolved parameter actually used, including the seed. */
  params: Required<SamplingParams>;
  timings: Timings;
  messages: string[];
  device: string;
  precision: string;
}

export interface HistoryPage {
  items: HistorySummary[];
  total: number;
}

export interface Preferences {
  watermark_enabled: boolean;
  history_max_entries: number;
  history_max_bytes: number;
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
  | 'sidecar_not_ready'
  | 'model_load_failed'
  | 'model_load_timeout';

export interface AppError {
  code: ErrorCode;
  detail: string | null;
}

export type AppStatus = 'setup' | 'starting' | 'loading_model' | 'ready' | 'error';

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
