// Script screen actions: create / import / open, settings, edits and the render job. The
// job's SSE stream lives outside React so rendering keeps updating on other screens.
import { requestParams, valuesFrom } from '@/features/params/schema';
import { codeOf, failureOf } from '@/lib/jobs';
import { subscribeJob } from '@/lib/sse';
import type {
  ParamSchema,
  Script,
  ScriptRenderRequest,
  ScriptResult,
  ScriptSettings,
} from '@/lib/types';
import { type ScriptDraft, useScriptStore } from '@/store/script';
import { useSidecarStore } from '@/store/sidecar';

const store = useScriptStore.getState;

let stopStream: (() => void) | null = null;

export function draftFrom(settings: ScriptSettings, schema: ParamSchema[]): ScriptDraft {
  return {
    values: valuesFrom(settings.params, schema),
    pauseMs: settings.pause_ms,
    namingTemplate: settings.naming_template,
    subtitleSpeakers: settings.subtitle_speakers,
    applyDictionary: settings.apply_dictionary,
  };
}

/** Parameters left at the schema default stay unset, so each voice's defaults apply. */
export function settingsFrom(draft: ScriptDraft, schema: ParamSchema[]): ScriptSettings {
  return {
    params: requestParams(schema, draft.values),
    pause_ms: draft.pauseMs,
    naming_template: draft.namingTemplate,
    subtitle_speakers: draft.subtitleSpeakers,
    apply_dictionary: draft.applyDictionary,
  };
}

export async function loadRecent(): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  try {
    store().setRecent(await api.listScripts());
  } catch {
    // The list is a convenience; the screen works without it.
  }
}

export async function openScript(id: string, schema: ParamSchema[]): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  const script = await api.getScript(id);
  store().open(script, draftFrom(script.settings, schema));
  // A render still in progress (e.g. started before switching scripts): follow it.
  const jobId = script.render_job_id;
  if (jobId && store().job?.id !== jobId) {
    stopStream?.();
    store().beginJob();
    store().jobAccepted(jobId, 0);
    follow(script.id, jobId);
  }
}

/** A new script from the pasted text or table. */
export async function createScript(schema: ParamSchema[]): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  const { source, format, draft } = store();
  const created = await api.createScript({
    source,
    format,
    settings: settingsFrom(draft, schema),
  });
  store().open(created, draft);
  void loadRecent();
}

/** More lines for the open script: appended, or replacing every line (and take). */
export async function importLines(mode: 'append' | 'replace'): Promise<void> {
  const api = useSidecarStore.getState().api;
  const { source, format, script } = store();
  if (!api || !script) return;
  store().replace(await api.importScript(script.id, { source, format, mode }));
  store().setSource('');
  void loadRecent();
}

export async function saveSettings(schema: ParamSchema[]): Promise<void> {
  const api = useSidecarStore.getState().api;
  const { script, draft, settingsDirty } = store();
  if (!api || !script || !settingsDirty) return;
  const saved = await api.updateScript(script.id, { settings: settingsFrom(draft, schema) });
  store().settingsSaved(saved);
}

/** Render lines as one job (default: every line without a take, i.e. resume). */
export async function render(schema: ParamSchema[], body: ScriptRenderRequest = {}): Promise<void> {
  const api = useSidecarStore.getState().api;
  const script = store().script;
  if (!api || !script) return;
  stopStream?.();
  stopStream = null;
  store().beginJob();
  try {
    await saveSettings(schema);
    const accepted = await api.renderScript(script.id, body);
    if (!accepted) {
      store().applyEvent({ type: 'completed', data: { script_id: script.id, rendered: 0 } });
      return;
    }
    store().jobAccepted(accepted.job_id, accepted.queue_position, expected(script, body));
    follow(script.id, accepted.job_id);
  } catch (err) {
    store().failJob(failureOf(err));
  }
}

/** Lines a render request covers, in order. */
function expected(script: Script, body: ScriptRenderRequest): string[] {
  const chosen = body.line_ids ? new Set(body.line_ids) : null;
  return script.lines
    .filter((line) => (!chosen || chosen.has(line.id)) && (body.redo || !line.adopted_audio_id))
    .map((line) => line.id);
}

export async function cancelRender(): Promise<void> {
  const api = useSidecarStore.getState().api;
  const jobId = store().job?.id;
  if (api && jobId) await api.cancelJob(jobId).catch(() => undefined);
}

function follow(scriptId: string, jobId: string): void {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  stopStream = subscribeJob<ScriptResult>(api.jobEventsUrl(jobId), {
    onEvent: (event) => {
      if (store().script?.id !== scriptId) return;
      store().applyEvent(event);
      if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
        void refresh(scriptId);
      }
    },
    onError: () => store().failJob({ code: 'job_not_found' }),
  });
}

async function refresh(scriptId: string): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  try {
    const script = await api.getScript(scriptId);
    if (store().script?.id === scriptId) store().replace(script);
  } catch {
    // Deleted meanwhile.
  }
  void loadRecent();
}

/** Run an edit that returns the new script; resolves to an error code or null. */
export async function edit(action: () => Promise<Script>): Promise<string | null> {
  try {
    const script = await action();
    if (store().script?.id === script.id) store().replace(script);
    return null;
  } catch (err) {
    return codeOf(err);
  }
}
