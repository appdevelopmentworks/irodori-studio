// Library screen actions: loading and filtering the history, generating an entry again,
// adopting, deleting, saving and exporting entries, and reusing an entry's request on the
// Quick screen. Regenerate streams live outside React so they finish on other screens.
import { usableOutput, postOf } from '@/features/output/output';
import { codeOf } from '@/lib/jobs';
import { subscribeJob } from '@/lib/sse';
import type {
  ClipInfo,
  HistoryQuery,
  HistorySummary,
  ParamSchema,
  TtsResult,
} from '@/lib/types';
import { type LibraryFilters, useLibraryStore } from '@/store/library';
import { useNavStore } from '@/store/nav';
import { useQuickStore } from '@/store/quick';
import { useSidecarStore } from '@/store/sidecar';

export const PAGE_SIZE = 50;

const store = useLibraryStore.getState;

/** Local calendar dates as the API's UTC bounds: `from` inclusive, `to` inclusive. */
export function queryOf(filters: LibraryFilters): HistoryQuery {
  const query: HistoryQuery = {};
  if (filters.q.trim()) query.q = filters.q.trim();
  if (filters.voice) query.voice = filters.voice;
  if (filters.from) query.since = new Date(`${filters.from}T00:00:00`).toISOString();
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query.before = end.toISOString();
  }
  return query;
}

export async function loadHistory(append = false): Promise<string | null> {
  const api = useSidecarStore.getState().api;
  if (!api) return null;
  const { filters, items } = store();
  const offset = append ? (items?.length ?? 0) : 0;
  try {
    const page = await api.getHistory({ ...queryOf(filters), limit: PAGE_SIZE, offset });
    if (store().filters === filters) store().setPage(page.items, page.total, append);
    return null;
  } catch (err) {
    return codeOf(err);
  }
}

export async function loadUsage(): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  try {
    store().setUsage(await api.getHistoryUsage());
  } catch {
    // Shown when available.
  }
}

/** The entry's request again: the same seed, or a new random one. */
export async function regenerate(entry: HistorySummary, newSeed: boolean): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  store().setError(entry.id, null);
  store().setJob(entry.id, 'submitting');
  try {
    const accepted = await api.regenerate(entry.id, newSeed ? { seed: null } : {});
    store().setJob(entry.id, 'queued');
    subscribeJob<TtsResult>(api.jobEventsUrl(accepted.job_id), {
      onEvent: (event) => {
        if (event.type === 'started') store().setJob(entry.id, 'running');
        if (event.type === 'completed') {
          store().setJob(entry.id, null);
          void loadHistory();
          void loadUsage();
        }
        if (event.type === 'failed') {
          store().setJob(entry.id, null);
          store().setError(entry.id, event.data.code);
        }
        if (event.type === 'cancelled') store().setJob(entry.id, null);
      },
      onError: () => {
        store().setJob(entry.id, null);
        store().setError(entry.id, 'job_not_found');
      },
    });
  } catch (err) {
    store().setJob(entry.id, null);
    store().setError(entry.id, codeOf(err));
  }
}

export async function adopt(entry: HistorySummary, audioId: string | null): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  try {
    const updated = await api.updateHistoryEntry(entry.id, { adopted_audio_id: audioId });
    store().replaceItem(updated);
    store().setError(entry.id, null);
  } catch (err) {
    store().setError(entry.id, codeOf(err));
  }
}

export async function remove(ids: string[]): Promise<string | null> {
  const api = useSidecarStore.getState().api;
  if (!api) return null;
  const done: string[] = [];
  let failure: string | null = null;
  for (const id of ids) {
    try {
      await api.deleteHistoryEntry(id);
      done.push(id);
    } catch (err) {
      failure = codeOf(err);
    }
  }
  store().removeItems(done);
  void loadUsage();
  return failure;
}

/** The export settings every screen shares, as far as ffmpeg allows. */
export function currentOutput() {
  const { preferences, system } = useSidecarStore.getState();
  return usableOutput(preferences?.output, system?.ffmpeg_available ?? false);
}

/** Save one candidate where the user chose (the shared export settings apply). */
export async function saveCandidate(audioId: string, path: string): Promise<string> {
  const api = useSidecarStore.getState().api;
  if (!api) throw new Error('offline');
  const output = currentOutput();
  const saved = await api.saveAudio(audioId, path, output.format, postOf(output));
  return saved.path;
}

export async function exportEntries(ids: string[], folder: string, template: string) {
  const api = useSidecarStore.getState().api;
  if (!api) throw new Error('offline');
  const output = currentOutput();
  return api.exportHistory({
    history_ids: ids,
    folder,
    format: output.format,
    post: postOf(output),
    naming_template: template,
  });
}

/** Load an entry's request into the Quick screen and go there. Resolves to an error code
 * when some of its reference clips are gone (the rest are used). */
export async function reuse(entry: HistorySummary, schema: ParamSchema[]): Promise<string | null> {
  const api = useSidecarStore.getState().api;
  if (!api) return null;
  const full = store().details[entry.id] ?? (await api.getHistoryEntry(entry.id));
  const reference = full.request.reference;
  let clips: ClipInfo[] = [];
  let missing = false;
  if (reference?.kind === 'clips') {
    const found = await Promise.allSettled(reference.clip_ids.map((id) => api.getClip(id)));
    clips = found.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    missing = clips.length < reference.clip_ids.length;
  }
  useQuickStore.getState().loadRequest(full.request, schema, clips);
  useNavStore.getState().setScreen('quick');
  return missing ? 'clip_not_found' : null;
}
