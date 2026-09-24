// ALL internal-API (sidecar) calls go through this module. The port comes from the
// `get_sidecar_port` Tauri command via the app store (D10); never write a port literal.
import type {
  AssembledNarration,
  AssembledScript,
  AudioFormat,
  CancelResponse,
  ChunkPatch,
  ClipInfo,
  ClipOrigin,
  DictionaryEntry,
  DictionaryEntryInput,
  EmojiItem,
  ExportedFile,
  ErrorResponse,
  FileNames,
  HealthResponse,
  HistoryEntry,
  HistoryPage,
  HistoryPatch,
  JobAccepted,
  JobInfo,
  LineInsert,
  LinePatch,
  ModelCapabilities,
  ModelInfo,
  Narration,
  NarrationCreate,
  NarrationExported,
  NarrationExportRequest,
  NarrationPatch,
  NarrationSplit,
  NarrationSummary,
  Preferences,
  QueueSnapshot,
  ReadingResult,
  RenderRequest,
  SavedFile,
  Script,
  ScriptCreate,
  ScriptExported,
  ScriptExportRequest,
  ScriptImport,
  ScriptPatch,
  ScriptRenderRequest,
  ScriptSummary,
  ScriptTableRequest,
  SynthesisRequest,
  SystemInfo,
  Voice,
  VoiceCreate,
  VoicePatch,
  VoiceSaved,
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
    /** Saves a copy at an absolute path (from the native save dialog); formats other
     * than WAV need ffmpeg. */
    saveAudio: (audioId: string, path: string, format: AudioFormat) =>
      send<SavedFile>(`${base}/audio/${audioId}/save`, json('POST', { path, format })),

    uploadClip: (file: Blob, filename: string, origin: Exclude<ClipOrigin, 'generated'> = 'upload') => {
      const form = new FormData();
      form.append('file', file, filename);
      form.append('origin', origin);
      return send<ClipInfo>(`${base}/clips`, { method: 'POST', body: form });
    },
    getClip: (clipId: string) => send<ClipInfo>(`${base}/clips/${clipId}`),
    /** 16-bit WAV of a clip for playback and waveforms. */
    clipAudioUrl: (clipId: string) => `${base}/clips/${clipId}/audio`,
    /** The kept range becomes a new clip that replaces this one (in its voice too). */
    trimClip: (clipId: string, startS: number, endS: number) =>
      send<ClipInfo>(`${base}/clips/${clipId}/trim`, json('POST', { start_s: startS, end_s: endS })),
    /** The pieces replace this clip (in its voice too). */
    splitClip: (clipId: string, atS: number[]) =>
      send<ClipInfo[]>(`${base}/clips/${clipId}/split`, json('POST', { at_s: atS })),
    deleteClip: (clipId: string) => send<void>(`${base}/clips/${clipId}`, { method: 'DELETE' }),

    listVoices: () => send<Voice[]>(`${base}/voices`),
    getVoice: (voiceId: string) => send<Voice>(`${base}/voices/${voiceId}`),
    createVoice: (body: VoiceCreate) => send<VoiceSaved>(`${base}/voices`, json('POST', body)),
    updateVoice: (voiceId: string, patch: VoicePatch) =>
      send<VoiceSaved>(`${base}/voices/${voiceId}`, json('PATCH', patch)),
    /** Deletes the voice together with its clips (D13). */
    deleteVoice: (voiceId: string) => send<void>(`${base}/voices/${voiceId}`, { method: 'DELETE' }),
    /** `null` when the voice is already encoded for the active model. */
    encodeVoice: (voiceId: string) =>
      send<JobAccepted | null>(`${base}/voices/${voiceId}/encode`, { method: 'POST' }),
    /** Writes an `.irovoice` package at an absolute path (from the native save dialog). */
    exportVoice: (voiceId: string, path: string) =>
      send<ExportedFile>(`${base}/voices/${voiceId}/export`, json('POST', { path })),
    importVoice: (file: Blob, filename: string) => {
      const form = new FormData();
      form.append('file', file, filename);
      return send<VoiceSaved>(`${base}/voices/import`, { method: 'POST', body: form });
    },

    getDictionary: () => send<DictionaryEntry[]>(`${base}/dictionary`),
    /** Replaces the whole dictionary. */
    putDictionary: (entries: DictionaryEntryInput[]) =>
      send<DictionaryEntry[]>(`${base}/dictionary`, json('PUT', entries)),
    getReading: (text: string, applyDictionary = true) =>
      send<ReadingResult>(
        `${base}/text/reading`,
        json('POST', { text, apply_dictionary: applyDictionary }),
      ),

    listNarrations: () => send<NarrationSummary[]>(`${base}/narrations`),
    createNarration: (body: NarrationCreate) =>
      send<Narration>(`${base}/narrations`, json('POST', body)),
    getNarration: (id: string) => send<Narration>(`${base}/narrations/${id}`),
    updateNarration: (id: string, patch: NarrationPatch) =>
      send<Narration>(`${base}/narrations/${id}`, json('PATCH', patch)),
    deleteNarration: (id: string) =>
      send<void>(`${base}/narrations/${id}`, { method: 'DELETE' }),
    /** Split again: every take is discarded. */
    splitNarration: (id: string, body: NarrationSplit) =>
      send<Narration>(`${base}/narrations/${id}/split`, json('POST', body)),
    updateChunk: (id: string, index: number, patch: ChunkPatch) =>
      send<Narration>(`${base}/narrations/${id}/chunks/${index}`, json('PATCH', patch)),
    /** `null` when no chunk needs rendering. */
    renderNarration: (id: string, body: RenderRequest = {}) =>
      send<JobAccepted | null>(`${base}/narrations/${id}/render`, json('POST', body)),
    assembleNarration: (id: string) =>
      send<AssembledNarration>(`${base}/narrations/${id}/assemble`, { method: 'POST' }),
    exportNarration: (id: string, body: NarrationExportRequest) =>
      send<NarrationExported>(`${base}/narrations/${id}/export`, json('POST', body)),

    listScripts: () => send<ScriptSummary[]>(`${base}/scripts`),
    createScript: (body: ScriptCreate) => send<Script>(`${base}/scripts`, json('POST', body)),
    getScript: (id: string) => send<Script>(`${base}/scripts/${id}`),
    updateScript: (id: string, patch: ScriptPatch) =>
      send<Script>(`${base}/scripts/${id}`, json('PATCH', patch)),
    deleteScript: (id: string) => send<void>(`${base}/scripts/${id}`, { method: 'DELETE' }),
    /** More lines from text or a table (`replace` discards every take). */
    importScript: (id: string, body: ScriptImport) =>
      send<Script>(`${base}/scripts/${id}/import`, json('POST', body)),
    insertLine: (id: string, body: LineInsert) =>
      send<Script>(`${base}/scripts/${id}/lines`, json('POST', body)),
    updateLine: (id: string, lineId: string, patch: LinePatch) =>
      send<Script>(`${base}/scripts/${id}/lines/${lineId}`, json('PATCH', patch)),
    deleteLine: (id: string, lineId: string) =>
      send<Script>(`${base}/scripts/${id}/lines/${lineId}`, { method: 'DELETE' }),
    moveLine: (id: string, lineId: string, position: number) =>
      send<Script>(`${base}/scripts/${id}/lines/${lineId}/move`, json('POST', { position })),
    /** `null` when no line needs rendering. */
    renderScript: (id: string, body: ScriptRenderRequest = {}) =>
      send<JobAccepted | null>(`${base}/scripts/${id}/render`, json('POST', body)),
    assembleScript: (id: string) =>
      send<AssembledScript>(`${base}/scripts/${id}/assemble`, { method: 'POST' }),
    /** Per-line files, the merged drama and subtitles into a folder (files of the same
     * name are overwritten). */
    exportScript: (id: string, body: ScriptExportRequest) =>
      send<ScriptExported>(`${base}/scripts/${id}/export`, json('POST', body)),
    /** The per-line file names a naming template gives (to preview it). */
    previewFileNames: (id: string, namingTemplate: string) =>
      send<FileNames>(
        `${base}/scripts/${id}/file-names`,
        json('POST', { naming_template: namingTemplate }),
      ),
    /** The lines as CSV / TSV (UTF-8 with a BOM) at an absolute path. */
    exportScriptTable: (id: string, body: ScriptTableRequest) =>
      send<ExportedFile>(`${base}/scripts/${id}/table`, json('POST', body)),

    getHistory: (params: { limit?: number; offset?: number; q?: string } = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') query.set(key, String(value));
      }
      return send<HistoryPage>(`${base}/history?${query}`);
    },
    getHistoryEntry: (id: string) => send<HistoryEntry>(`${base}/history/${id}`),
    updateHistoryEntry: (id: string, patch: HistoryPatch) =>
      send<HistoryEntry>(`${base}/history/${id}`, json('PATCH', patch)),
    deleteHistoryEntry: (id: string) => send<void>(`${base}/history/${id}`, { method: 'DELETE' }),

    getPreferences: () => send<Preferences>(`${base}/preferences`),
    updatePreferences: (patch: Partial<Preferences>) =>
      send<Preferences>(`${base}/preferences`, json('PATCH', patch)),
  };
}

export type Api = ReturnType<typeof createApi>;
