// Maps stable error codes from Rust (src-tauri/src/error.rs) and the sidecar
// (sidecar/app/errors.py) to i18n keys; backends never send user-facing prose (D17).
import type { ErrorCode, SidecarErrorCode, SystemIssue } from './types';

export type KnownErrorCode = ErrorCode | SystemIssue | SidecarErrorCode;

const KNOWN_CODES = new Set<string>([
  // Rust
  'internal',
  'settings_io',
  'invalid_locale',
  'platform_unsupported',
  'data_root_invalid',
  'data_root_not_writable',
  'disk_space_insufficient',
  'setup_already_running',
  'sidecar_source_missing',
  'uv_missing',
  'python_install_failed',
  'venv_failed',
  'deps_install_failed',
  'torch_install_failed',
  'network_error',
  'download_failed',
  'selfcheck_failed',
  'cuda_unavailable',
  'mps_unavailable',
  'sidecar_spawn_failed',
  'sidecar_exited',
  'sidecar_health_timeout',
  'sidecar_not_ready',
  'model_load_failed',
  'model_load_timeout',
  // Sidecar
  'internal_error',
  'torch_unavailable',
  'watermark_unavailable',
  'model_files_missing',
  'model_not_loaded',
  'upstream_incompatible',
  'upstream_unavailable',
  'invalid_request',
  'invalid_params',
  'text_empty',
  'text_too_long',
  'caption_unsupported',
  'reference_unsupported',
  'lora_unsupported',
  'lora_not_found',
  'lora_incompatible_with_compile',
  'embedding_not_found',
  'voice_not_found',
  'clip_not_found',
  'clip_format_unsupported',
  'clip_decode_failed',
  'clip_empty',
  'clip_too_short',
  'clip_too_long',
  'clip_too_large',
  'job_not_found',
  'audio_not_found',
  'history_not_found',
  'synthesis_failed',
  'out_of_memory',
] satisfies KnownErrorCode[]);

/** Error code from a rejected command or thrown value; unknown values become `internal`. */
export function errorCodeOf(value: unknown): KnownErrorCode {
  const code = typeof value === 'string' ? value : (value as { code?: unknown } | null)?.code;
  return typeof code === 'string' && KNOWN_CODES.has(code) ? (code as KnownErrorCode) : 'internal';
}
