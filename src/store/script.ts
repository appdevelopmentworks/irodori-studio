// Script screen state: the text being imported, the open script (from the sidecar),
// unsaved settings and the render job. Kept while the user switches screens; memory only
// (D11).
import { create } from 'zustand';

import type { ParamName, ParamValue, ParamValues } from '@/features/params/schema';
import { type JobFailure, type JobState, reduceJob, submittingJob, withFailure } from '@/lib/jobs';
import type { JobEvent, Script, ScriptFormat, ScriptResult, ScriptSummary } from '@/lib/types';

/** Script settings as the form edits them (see features/script/actions.ts). */
export interface ScriptDraft {
  values: ParamValues;
  pauseMs: number;
  namingTemplate: string;
  subtitleSpeakers: boolean;
  applyDictionary: boolean;
}

export interface ScriptRenderJob extends JobState<ScriptResult> {
  lines: { done: number; total: number } | null;
  /** Sampling steps of the line being rendered. */
  steps: { done: number; total: number } | null;
  /** Lines the job has yet to render, in order (unknown for a job followed after
   * reopening the script). */
  pending: string[];
}

export const DEFAULT_TEMPLATE = '{index}_{speaker}_{text_head}';
export const DEFAULT_PAUSE_MS = 500;

export const emptyDraft = (): ScriptDraft => ({
  values: {},
  pauseMs: DEFAULT_PAUSE_MS,
  namingTemplate: DEFAULT_TEMPLATE,
  subtitleSpeakers: true,
  applyDictionary: true,
});

interface ScriptStore {
  source: string;
  format: ScriptFormat;
  script: Script | null;
  recent: ScriptSummary[] | null;
  draft: ScriptDraft;
  settingsDirty: boolean;
  invalid: Partial<Record<ParamName, true>>;
  job: ScriptRenderJob | null;
  /** Per-line file names the draft's naming template gives (from the sidecar). */
  fileNames: string[] | null;
  fileNamesError: string | null;

  setSource: (source: string, format?: ScriptFormat) => void;
  setFormat: (format: ScriptFormat) => void;
  /** Show a script from the sidecar, with its settings as the form's draft. */
  open: (script: Script, draft: ScriptDraft) => void;
  /** Newer state of the open script (the draft stays). */
  replace: (script: Script) => void;
  startNew: () => void;
  setRecent: (recent: ScriptSummary[]) => void;
  updateDraft: (patch: Partial<ScriptDraft>) => void;
  setParam: (name: ParamName, value: ParamValue, defaultValue: ParamValue) => void;
  setInvalid: (name: ParamName, invalid: boolean) => void;
  settingsSaved: (script: Script) => void;

  beginJob: () => void;
  /** `pending`: the lines the job will render, when known. */
  jobAccepted: (id: string, position: number, pending?: string[]) => void;
  applyEvent: (event: JobEvent<ScriptResult>) => void;
  failJob: (failure: JobFailure) => void;
  setFileNames: (names: string[] | null, error?: string | null) => void;
}

export const useScriptStore = create<ScriptStore>((set) => ({
  source: '',
  format: 'text',
  script: null,
  recent: null,
  draft: emptyDraft(),
  settingsDirty: false,
  invalid: {},
  job: null,
  fileNames: null,
  fileNamesError: null,

  setSource: (source, format) => set((s) => ({ source, format: format ?? s.format })),
  setFormat: (format) => set({ format }),
  open: (script, draft) =>
    set((s) => ({
      script,
      source: '',
      draft,
      settingsDirty: false,
      invalid: {},
      // Reopening the same script keeps following its render.
      job: s.script?.id === script.id ? s.job : null,
      fileNames: s.script?.id === script.id ? s.fileNames : null,
      fileNamesError: null,
    })),
  replace: (script) => set({ script }),
  startNew: () =>
    set({
      script: null,
      source: '',
      format: 'text',
      draft: emptyDraft(),
      settingsDirty: false,
      invalid: {},
      job: null,
      fileNames: null,
      fileNamesError: null,
    }),
  setRecent: (recent) => set({ recent }),
  updateDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch }, settingsDirty: true })),
  setParam: (name, value, defaultValue) =>
    set((s) => {
      const values = { ...s.draft.values };
      if (value === defaultValue) delete values[name];
      else values[name] = value;
      return { draft: { ...s.draft, values }, settingsDirty: true };
    }),
  setInvalid: (name, invalid) =>
    set((s) => {
      if (Boolean(s.invalid[name]) === invalid) return {};
      const next = { ...s.invalid };
      if (invalid) next[name] = true;
      else delete next[name];
      return { invalid: next };
    }),
  settingsSaved: (script) => set({ script, settingsDirty: false }),

  beginJob: () =>
    set({
      job: { ...submittingJob<ScriptResult>(), lines: null, steps: null, pending: [] },
    }),
  jobAccepted: (id, position, pending) =>
    set((s) => {
      if (!s.job) return {};
      const lines = pending ? { done: 0, total: pending.length } : s.job.lines;
      return {
        job: { ...s.job, id, phase: 'queued', position, lines, pending: pending ?? [] },
      };
    }),
  applyEvent: (event) =>
    set((s) => {
      if (!s.job) return {};
      let job = reduceJob(s.job, event);
      let script = s.script;
      if (event.type === 'progress') {
        const progress = { done: event.data.done, total: event.data.total };
        if (event.data.unit === 'line') {
          // A line skipped (edited or deleted meanwhile) sends no `line` event.
          const remaining = Math.max(0, progress.total - progress.done);
          job = {
            ...job,
            lines: progress,
            steps: null,
            pending: job.pending.slice(Math.max(0, job.pending.length - remaining)),
          };
        } else {
          job = { ...job, steps: progress };
        }
      }
      if (event.type === 'line') {
        const { line_id, takes, adopted_audio_id } = event.data;
        job = { ...job, pending: job.pending.filter((id) => id !== line_id) };
        if (script) {
          const lines = script.lines.map((line) =>
            line.id === line_id
              ? { ...line, takes: [...line.takes, ...takes], adopted_audio_id }
              : line,
          );
          script = { ...script, lines, assembled: null };
        }
      }
      if (job.finishedAt !== null) job = { ...job, pending: [] };
      return { job, script };
    }),
  failJob: (failure) =>
    set((s) => (s.job ? { job: { ...withFailure(s.job, failure), pending: [] } } : {})),
  setFileNames: (fileNames, error = null) => set({ fileNames, fileNamesError: error }),
}));
