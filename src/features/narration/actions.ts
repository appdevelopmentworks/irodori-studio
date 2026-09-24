// Narration screen actions: open / split / save settings, and the render job. The job's
// SSE stream lives outside React so rendering keeps updating on other screens.
import { requestParams, valuesFrom, voiceValues } from '@/features/params/schema';
import { codeOf, failureOf } from '@/lib/jobs';
import { subscribeJob } from '@/lib/sse';
import type {
  Narration,
  NarrationResult,
  NarrationSettings,
  ParamSchema,
  RenderRequest,
  Voice,
} from '@/lib/types';
import { type SettingsDraft, useNarrationStore } from '@/store/narration';
import { useSidecarStore } from '@/store/sidecar';

const store = useNarrationStore.getState;

let stopStream: (() => void) | null = null;

export function draftFrom(settings: NarrationSettings, schema: ParamSchema[]): SettingsDraft {
  return {
    voiceId: settings.reference.kind === 'voice' ? settings.reference.voice_id : null,
    caption: settings.caption ?? '',
    values: valuesFrom(settings.params, schema),
    loraPath: settings.lora_adapter,
    pauses: settings.pauses,
    voiceLock: settings.voice_lock,
    applyDictionary: settings.apply_dictionary,
  };
}

export function settingsFrom(draft: SettingsDraft, schema: ParamSchema[]): NarrationSettings {
  const caption = draft.caption.trim();
  return {
    reference: draft.voiceId ? { kind: 'voice', voice_id: draft.voiceId } : { kind: 'none' },
    caption: caption || null,
    lora_adapter: draft.loraPath,
    params: requestParams(schema, draft.values),
    pauses: draft.pauses,
    voice_lock: draft.voiceLock,
    apply_dictionary: draft.applyDictionary,
  };
}

/** The form after choosing a library voice: its defaults replace caption, parameters,
 * seed and LoRA (as on the Quick screen). */
export function draftWithVoice(
  draft: SettingsDraft,
  voice: Voice | null,
  schema: ParamSchema[],
): SettingsDraft {
  if (!voice) return { ...draft, voiceId: null };
  return {
    ...draft,
    voiceId: voice.id,
    caption: voice.caption_default ?? '',
    values: voiceValues(voice, schema),
    loraPath: voice.lora_path,
  };
}

export async function loadRecent(): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  try {
    store().setRecent(await api.listNarrations());
  } catch {
    // The list is a convenience; the screen works without it.
  }
}

export async function openNarration(id: string, schema: ParamSchema[]): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  const narration = await api.getNarration(id);
  store().open(narration, draftFrom(narration.settings, schema));
  // A render still in progress (e.g. started before switching narrations): follow it.
  const jobId = narration.render_job_id;
  if (jobId && store().job?.id !== jobId) {
    stopStream?.();
    store().beginJob();
    store().jobAccepted(jobId, 0);
    follow(narration.id, jobId);
  }
}

/** Split the manuscript: a new narration, or the open one again (its takes are
 * discarded). */
export async function split(schema: ParamSchema[]): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  const { source, format, rules, narration, draft } = store();
  if (narration) {
    await saveSettings(schema);
    store().replace(await api.splitNarration(narration.id, { source, format, rules }));
  } else {
    const created = await api.createNarration({
      source,
      format,
      rules,
      settings: settingsFrom(draft, schema),
    });
    store().open(created, draft);
  }
  store().clearReadings();
  void loadRecent();
}

export async function saveSettings(schema: ParamSchema[]): Promise<void> {
  const api = useSidecarStore.getState().api;
  const { narration, draft, settingsDirty } = store();
  if (!api || !narration || !settingsDirty) return;
  const saved = await api.updateNarration(narration.id, { settings: settingsFrom(draft, schema) });
  store().settingsSaved(saved);
}

/** Render chunks as one job (default: every chunk without a take, i.e. resume). */
export async function render(schema: ParamSchema[], body: RenderRequest = {}): Promise<void> {
  const api = useSidecarStore.getState().api;
  const narration = store().narration;
  if (!api || !narration) return;
  stopStream?.();
  stopStream = null;
  store().beginJob();
  try {
    await saveSettings(schema);
    const accepted = await api.renderNarration(narration.id, body);
    if (!accepted) {
      store().applyEvent({ type: 'completed', data: { narration_id: narration.id, rendered: 0 } });
      return;
    }
    store().jobAccepted(accepted.job_id, accepted.queue_position, expected(narration, body));
    follow(narration.id, accepted.job_id);
  } catch (err) {
    store().failJob(failureOf(err));
  }
}

/** Chunks a render request covers (the sidecar may add chunk 1 for the voice lock). */
function expected(narration: Narration, body: RenderRequest): number {
  const wanted = body.indices ?? narration.chunks.map((chunk) => chunk.index);
  return wanted.filter((i) => body.redo || !narration.chunks[i]?.adopted_audio_id).length;
}

export async function cancelRender(): Promise<void> {
  const api = useSidecarStore.getState().api;
  const jobId = store().job?.id;
  if (api && jobId) await api.cancelJob(jobId).catch(() => undefined);
}

function follow(narrationId: string, jobId: string): void {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  stopStream = subscribeJob<NarrationResult>(api.jobEventsUrl(jobId), {
    onEvent: (event) => {
      if (store().narration?.id !== narrationId) return;
      store().applyEvent(event);
      if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
        void refresh(narrationId);
      }
    },
    onError: () => store().failJob({ code: 'job_not_found' }),
  });
}

async function refresh(narrationId: string): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  try {
    const narration = await api.getNarration(narrationId);
    if (store().narration?.id === narrationId) store().replace(narration);
  } catch {
    // Deleted meanwhile.
  }
  void loadRecent();
}

/** Run an edit that returns the new narration; resolves to an error code or null. */
export async function edit(action: () => Promise<Narration>): Promise<string | null> {
  try {
    store().replace(await action());
    return null;
  } catch (err) {
    return codeOf(err);
  }
}
