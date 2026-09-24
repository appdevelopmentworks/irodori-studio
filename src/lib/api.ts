// ALL internal-API (sidecar) calls go through this module. The port comes from the
// `get_sidecar_port` Tauri command via the app store (D10); never write a port literal.
import type {
  CancelResponse,
  ClipInfo,
  EmojiItem,
  ErrorResponse,
  HealthResponse,
  HistoryEntry,
  HistoryPage,
  JobAccepted,
  JobInfo,
  ModelCapabilities,
  ModelInfo,
  Preferences,
  QueueSnapshot,
  SynthesisRequest,
  SystemInfo,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`${status} ${code}`);
  }
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null;
    throw new ApiError(response.status, body?.code ?? 'internal_error', body?.detail ?? {});
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function createApi(port: number) {
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    getHealth: () => send<HealthResponse>(`${base}/health`),
    getSystem: () => send<SystemInfo>(`${base}/system`),

    getModels: () => send<ModelInfo[]>(`${base}/models`),
    getCapabilities: () => send<ModelCapabilities>(`${base}/models/active/capabilities`),
    getEmoji: () => send<EmojiItem[]>(`${base}/emoji`),

    generate: (request: SynthesisRequest) =>
      send<JobAccepted>(`${base}/tts/generate`, json('POST', request)),
    getJob: (jobId: string) => send<JobInfo>(`${base}/jobs/${jobId}`),
    cancelJob: (jobId: string) =>
      send<CancelResponse>(`${base}/jobs/${jobId}/cancel`, { method: 'POST' }),
    getQueue: () => send<QueueSnapshot>(`${base}/queue`),
    /** Job event stream URL for `EventSource` (see sse.ts). */
    jobEventsUrl: (jobId: string) => `${base}/jobs/${jobId}/events`,
    /** Playable WAV URL for `<audio src>`. */
    audioUrl: (audioId: string) => `${base}/audio/${audioId}`,

    uploadClip: (file: Blob, filename: string) => {
      const form = new FormData();
      form.append('file', file, filename);
      return send<ClipInfo>(`${base}/clips`, { method: 'POST', body: form });
    },
    getClip: (clipId: string) => send<ClipInfo>(`${base}/clips/${clipId}`),
    deleteClip: (clipId: string) => send<void>(`${base}/clips/${clipId}`, { method: 'DELETE' }),

    getHistory: (params: { limit?: number; offset?: number; q?: string } = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') query.set(key, String(value));
      }
      return send<HistoryPage>(`${base}/history?${query}`);
    },
    getHistoryEntry: (id: string) => send<HistoryEntry>(`${base}/history/${id}`),
    deleteHistoryEntry: (id: string) => send<void>(`${base}/history/${id}`, { method: 'DELETE' }),

    getPreferences: () => send<Preferences>(`${base}/preferences`),
    updatePreferences: (patch: Partial<Preferences>) =>
      send<Preferences>(`${base}/preferences`, json('PATCH', patch)),
  };
}

export type Api = ReturnType<typeof createApi>;
