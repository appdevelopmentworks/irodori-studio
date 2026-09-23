// ALL internal-API (sidecar) calls go through this module. The port comes from the
// `get_sidecar_port` Tauri command via the app store (D10); never write a port literal.
import type { ErrorResponse, HealthResponse, SystemInfo } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null;
    throw new ApiError(response.status, body?.code ?? 'internal_error');
  }
  return (await response.json()) as T;
}

export function createApi(port: number) {
  const base = `http://127.0.0.1:${port}`;
  return {
    getHealth: () => getJson<HealthResponse>(`${base}/health`),
    getSystem: () => getJson<SystemInfo>(`${base}/system`),
  };
}

export type Api = ReturnType<typeof createApi>;
