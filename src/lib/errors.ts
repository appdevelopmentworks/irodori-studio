// Maps stable error codes from Rust (src-tauri/src/error.rs) and the sidecar
// (sidecar/app/errors.py) to i18n keys; backends never send user-facing prose (D17).
import type { ErrorCode, SystemIssue } from './types';

const KNOWN_CODES = new Set<string>([
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
  'torch_unavailable',
] satisfies (ErrorCode | SystemIssue)[]);

/** Error code from a rejected command or thrown value; unknown values become `internal`. */
export function errorCodeOf(value: unknown): ErrorCode | SystemIssue {
  const code = typeof value === 'string' ? value : (value as { code?: unknown } | null)?.code;
  return typeof code === 'string' && KNOWN_CODES.has(code)
    ? (code as ErrorCode | SystemIssue)
    : 'internal';
}
