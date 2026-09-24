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
  | 'ffmpeg_unavailable'
  | 'clip_range_invalid'
  | 'clip_in_use'
  | 'voice_invalid'
  | 'consent_required'
  | 'embedding_invalid'
  | 'package_invalid'
  | 'dictionary_invalid'
  | 'subtitle_invalid'
  | 'narration_not_found'
  | 'chunk_not_found'
  | 'narration_busy'
  | 'narration_incomplete'
  | 'script_invalid'
  | 'script_not_found'
  | 'line_not_found'
  | 'script_busy'
  | 'script_incomplete'
  | 'naming_template_invalid'
  | 'preset_not_found'
  | 'project_invalid';

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
  /** Rewrite the text with the user dictionary first (default true, D19). */
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

export type JobKind = 'tts' | 'encode' | 'narration' | 'script';

export interface JobInfo {
  job_id: string;
  kind: JobKind;
  state: JobState;
  queue_position: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: JobError | null;
  result: TtsResult | EncodeResult | NarrationResult | ScriptResult | null;
}

export interface CancelResponse {
  job_id: string;
  state: 'cancelled' | 'cancelling' | 'completed' | 'failed';
}

export interface QueueItem {
  job_id: string;
  kind: JobKind;
  source: 'ui' | 'api';
  state: 'queued' | 'running';
  created_at: string;
}

export interface QueueSnapshot {
  running: QueueItem | null;
  queued: QueueItem[];
}

/** Result of an `encode` job: the voice's clips encoded for the active model. */
export interface EncodeResult {
  voice_id: string;
  encoded: number;
}

/** Result of a `narration` render job. */
export interface NarrationResult {
  narration_id: string;
  rendered: number;
}

/** Result of a `script` render job. */
export interface ScriptResult {
  script_id: string;
  rendered: number;
}

/** `chunk` event of a narration render: a chunk's new takes (the first one adopted). */
export interface ChunkRendered {
  index: number;
  takes: Take[];
  adopted_audio_id: string;
}

/** `line` event of a script render: a line's new takes (the first one adopted). */
export interface LineRendered {
  line_id: string;
  index: number;
  takes: Take[];
  adopted_audio_id: string;
}

export type ProgressUnit = 'step' | 'clip' | 'candidate' | 'chunk' | 'line';

/** `GET /jobs/{id}/events` (SSE); the event name is `type`. `R` is the job's result. */
export type JobEvent<R = TtsResult> =
  | { type: 'queued'; data: { position: number } }
  | { type: 'started'; data: Record<string, never> }
  | { type: 'log'; data: { line: string } }
  | { type: 'progress'; data: { done: number; total: number; unit: ProgressUnit } }
  | { type: 'candidate'; data: AudioOutput }
  | { type: 'chunk'; data: ChunkRendered }
  | { type: 'line'; data: LineRendered }
  | { type: 'completed'; data: R }
  | { type: 'failed'; data: JobError }
  | { type: 'cancelled'; data: Record<string, never> };

export type JobEventType = JobEvent['type'];

// Clips, history, preferences.

/** Uploaded and recorded audio may be a real person's voice (consent, D13). */
export type ClipOrigin = 'upload' | 'recording' | 'generated';

export interface ClipInfo {
  clip_id: string;
  filename: string;
  duration_s: number;
  sample_rate: number;
  channels: number;
  created_at: string;
  origin: ClipOrigin;
  /** The library voice that owns the clip. */
  voice_id: string | null;
}

// Voices (the voice library).

export type VoiceSource = 'designed' | 'imported' | 'recorded' | 'embedding';

/** The statement the user confirmed, in the words and language they saw (D13). */
export interface ConsentInput {
  statement: string;
  locale: string;
}

export interface Consent extends ConsentInput {
  confirmed_at: string;
  version: number;
}

export interface EmbeddingInfo {
  filename: string;
  tokens: number;
  dim: number;
}

export interface Voice {
  id: string;
  name: string;
  source: VoiceSource;
  created_at: string;
  updated_at: string;
  model_id: string;
  caption_default: string | null;
  params_default: SamplingParams;
  seed_default: number | null;
  lora_path: string | null;
  test_text: string | null;
  design_caption: string | null;
  clips: ClipInfo[];
  total_seconds: number;
  embedding: EmbeddingInfo | null;
  consent: Consent | null;
  /** Some clip may be a real person's voice, so consent must be recorded. */
  consent_required: boolean;
  /** Reference latents are cached for the active model. */
  encoded: boolean;
}

export interface VoiceCreate {
  name: string;
  source: VoiceSource;
  clip_ids?: string[];
  /** designed: keep this generated candidate as the voice's clip. */
  from_audio_id?: string | null;
  /** embedding: absolute path of a speaker embedding to copy into the library. */
  embedding_path?: string | null;
  consent?: ConsentInput | null;
  caption_default?: string | null;
  params_default?: SamplingParams;
  seed_default?: number | null;
  lora_path?: string | null;
  test_text?: string | null;
  design_caption?: string | null;
}

/** Only the fields sent change; `null` clears a nullable field. */
export interface VoicePatch {
  name?: string;
  /** The voice's clips in order; clips left out are deleted. */
  clip_ids?: string[];
  embedding_path?: string | null;
  consent?: ConsentInput;
  caption_default?: string | null;
  params_default?: SamplingParams;
  seed_default?: number | null;
  lora_path?: string | null;
  test_text?: string | null;
}

export interface VoiceSaved {
  voice: Voice;
  /** The queued job encoding the voice's clips, when needed. */
  encode_job_id: string | null;
}

export interface ExportedFile {
  path: string;
  bytes: number;
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
  /** The library voice of a `{kind: "voice"}` request. */
  voice_id: string | null;
}

export interface HistoryPatch {
  adopted_audio_id: string | null;
}

export type AudioFormat = 'wav' | 'mp3' | 'm4a' | 'flac' | 'opus';
export type SampleRate = 48000 | 44100;
export type LoudnessTarget = -14 | -16 | -23;

/** Post-processing for exports (D20); the defaults change nothing. */
export interface PostOptions {
  /** Opus stays at 48 kHz. */
  sample_rate: SampleRate;
  /** Integrated LUFS target (EBU R128), or off. */
  loudness: LoudnessTarget | null;
  /** 0.5–2.0: a time stretch that keeps the pitch. */
  tempo: number;
  /** -20–20 dB; only when loudness is off. */
  gain_db: number;
}

/** Export settings the screens share (kept in preferences). */
export interface OutputOptions extends PostOptions {
  format: AudioFormat;
}

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

export interface HistoryQuery {
  limit?: number;
  offset?: number;
  q?: string;
  /** A library voice id, or `none` for entries without one. */
  voice?: string;
  /** ISO 8601 UTC, inclusive. */
  since?: string;
  /** ISO 8601 UTC, exclusive. */
  before?: string;
}

export interface HistoryUsage {
  entries: number;
  bytes: number;
}

export interface RegenerateRequest {
  /** Omitted: the entry's used seed (the same request); null: a new random seed. */
  seed?: number | null;
  num_candidates?: number | null;
}

export interface HistoryExportRequest {
  history_ids: string[];
  /** Absolute, from the native folder dialog. */
  folder: string;
  format?: AudioFormat;
  post?: PostOptions | null;
  /** {date} 20260925-143000 (local), {n}, {index} 001, {text_head}, {seed}, {id}. */
  naming_template?: string;
}

export interface HistoryExported {
  files: ExportedFile[];
}

// Text: the user dictionary and the reading preview (D19).

export interface DictionaryEntryInput {
  /** As written in the text. */
  surface: string;
  /** What the model is given instead (usually katakana). */
  reading: string;
  enabled: boolean;
  note: string | null;
}

export interface DictionaryEntry extends DictionaryEntryInput {
  id: string;
}

export interface ReadingToken {
  surface: string;
  /** Estimated katakana: a hint, not what the model will say. */
  reading: string;
  moras: number;
  source: 'analyzer' | 'dictionary' | 'symbol' | 'text';
}

export interface ReadingResult {
  tokens: ReadingToken[];
  moras: number;
  estimated_seconds: number;
  /** False: no analyzer yet; tokens are the plain text. */
  analyzer: boolean;
}

// Narration (D18).

export type NarrationFormat = 'text' | 'markdown' | 'srt';
export type PauseKind = 'clause' | 'sentence' | 'paragraph' | 'cue';

export interface SplitRules {
  min_chars: number;
  max_chars: number;
}

export interface Pauses {
  sentence_ms: number;
  paragraph_ms: number;
}

export interface NarrationSettings {
  reference: ReferenceInput;
  caption: string | null;
  lora_adapter: string | null;
  params: SamplingParams;
  pauses: Pauses;
  /** Without speaker audio, chunk 1's take becomes the others' reference. */
  voice_lock: boolean;
  apply_dictionary: boolean;
}

export interface Cue {
  start_ms: number;
  end_ms: number;
}

export interface SubtitleCue extends Cue {
  index: number;
  text: string;
}

/** Generated audio of a narration chunk or a script line; plays via `/audio/{id}`. */
export interface Take {
  audio_id: string;
  duration_s: number;
  seed: number;
  /** Hit the output limit: the chunk text may be cut off. */
  truncated: boolean;
  created_at: string;
}

export interface NarrationChunk {
  index: number;
  text: string;
  pause_after: PauseKind;
  estimated_seconds: number;
  /** SRT input: the cue this chunk must fit. */
  cue: Cue | null;
  takes: Take[];
  adopted_audio_id: string | null;
}

export interface NarrationWarning {
  code: 'cue_too_long' | 'cue_overlap' | 'chunk_too_long';
  index: number;
}

export interface AssembledNarration {
  audio_id: string;
  duration_s: number;
  cues: SubtitleCue[];
}

export interface Narration {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  format: NarrationFormat;
  source: string;
  rules: SplitRules;
  settings: NarrationSettings;
  chunks: NarrationChunk[];
  warnings: NarrationWarning[];
  assembled: AssembledNarration | null;
  /** Estimates come from mora counts (true) or characters. */
  analyzer: boolean;
  /** The render job queued or running, to follow. */
  render_job_id: string | null;
}

export interface NarrationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  format: NarrationFormat;
  chunks: number;
  rendered: number;
}

export interface NarrationCreate {
  title?: string | null;
  source: string;
  format?: NarrationFormat;
  rules?: SplitRules;
  settings?: NarrationSettings;
}

export interface NarrationPatch {
  title?: string;
  settings?: NarrationSettings;
}

export interface NarrationSplit {
  source: string;
  format?: NarrationFormat;
  rules?: SplitRules;
}

export interface ChunkPatch {
  text?: string;
  adopted_audio_id?: string | null;
}

export interface RenderRequest {
  /** Omitted: every chunk without an adopted take (resume). */
  indices?: number[] | null;
  /** Also chunks that have takes (a new take is added and adopted). */
  redo?: boolean;
  num_candidates?: number | null;
}

export interface NarrationExportRequest {
  path: string;
  format?: AudioFormat;
  subtitles?: ('srt' | 'vtt')[];
  per_chunk?: boolean;
  /** Subtitles follow a changed tempo. */
  post?: PostOptions | null;
}

export interface NarrationExported {
  files: ExportedFile[];
}

// Scripts (requirements §6.7).

export type ScriptFormat = 'text' | 'csv' | 'tsv';

/** Who says a line: a library voice (its defaults apply) or none, plus a caption for all
 * of the speaker's lines (a line's own caption wins). */
export interface ScriptSpeaker {
  name: string;
  voice_id: string | null;
  caption: string | null;
}

export interface ScriptSettings {
  /** For every line, over each voice's defaults; a line's own values win. */
  params: SamplingParams;
  /** After a line, unless the line says otherwise. */
  pause_ms: number;
  /** Per-line file names: {index} 001, {n} 1, {speaker}, {text_head}, {title}, {id}. */
  naming_template: string;
  /** "話者：セリフ" in the subtitles. */
  subtitle_speakers: boolean;
  apply_dictionary: boolean;
}

export interface ScriptLineInput {
  speaker: string;
  text: string;
  caption?: string | null;
  num_candidates?: number | null;
  seed?: number | null;
  pause_ms?: number | null;
  /** Instead of the naming template. */
  file_name?: string | null;
}

export interface ScriptLine {
  id: string;
  index: number;
  speaker: string;
  text: string;
  caption: string | null;
  num_candidates: number | null;
  seed: number | null;
  pause_ms: number | null;
  file_name: string | null;
  takes: Take[];
  adopted_audio_id: string | null;
}

export interface ScriptCue extends SubtitleCue {
  line_id: string;
  speaker: string;
}

export interface AssembledScript {
  audio_id: string;
  duration_s: number;
  cues: ScriptCue[];
}

export interface Script {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  speakers: ScriptSpeaker[];
  settings: ScriptSettings;
  lines: ScriptLine[];
  assembled: AssembledScript | null;
  /** The render job queued or running, to follow. */
  render_job_id: string | null;
}

export interface ScriptSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  lines: number;
  rendered: number;
  speakers: number;
}

export interface ScriptCreate {
  title?: string | null;
  source: string;
  format?: ScriptFormat;
  settings?: ScriptSettings;
}

export interface ScriptImport {
  source: string;
  format?: ScriptFormat;
  /** `replace` discards every line and take; `append` adds at the end. */
  mode?: 'replace' | 'append';
}

export interface ScriptPatch {
  title?: string;
  settings?: ScriptSettings;
  speakers?: ScriptSpeaker[];
}

/** Only the fields sent change (`null` clears). New text or another speaker discards
 * the line's takes. */
export interface LinePatch {
  speaker?: string;
  text?: string;
  caption?: string | null;
  num_candidates?: number | null;
  seed?: number | null;
  pause_ms?: number | null;
  file_name?: string | null;
  adopted_audio_id?: string | null;
}

export interface LineInsert {
  line: ScriptLineInput;
  /** Omitted: at the end. */
  position?: number | null;
}

export interface ScriptRenderRequest {
  /** Omitted: every line without an adopted take (resume). */
  line_ids?: string[] | null;
  /** Also lines that have takes (a new take is added and adopted). */
  redo?: boolean;
  num_candidates?: number | null;
}

export interface ScriptExportRequest {
  /** Absolute, from the native folder dialog. */
  folder: string;
  format?: AudioFormat;
  per_line?: boolean;
  merged?: boolean;
  subtitles?: ('srt' | 'vtt')[];
  /** Subtitles follow a changed tempo. */
  post?: PostOptions | null;
}

export interface ScriptTableRequest {
  path: string;
  format?: 'csv' | 'tsv';
}

export interface ScriptExported {
  files: ExportedFile[];
}

export interface FileNames {
  /** Per line, without the extension. */
  names: string[];
}

export interface Preferences {
  watermark_enabled: boolean;
  history_max_entries: number;
  history_max_bytes: number;
  output: OutputOptions;
}

// Presets and projects (requirements §6.8, D23).

export interface PresetInput {
  name: string;
  /** Only the values given; loading a preset changes just those. */
  params: SamplingParams;
}

export interface Preset extends PresetInput {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface PresetPatch {
  name?: string;
  params?: SamplingParams;
}

export type ProjectKind = 'narration' | 'script';

export interface ProjectOpened {
  kind: ProjectKind;
  id: string;
  /** Library voices the project used that this library lacks (dropped). */
  missing_voices: string[];
  /** LoRA adapters not found (dropped). */
  missing_lora: string[];
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
