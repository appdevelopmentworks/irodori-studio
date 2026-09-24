// Narration screen state: the manuscript being edited, the open narration (from the
// sidecar), unsaved settings, the render job and reading previews. Kept while the user
// switches screens; memory only (D11).
import { create } from 'zustand';

import type { ParamName, ParamValue, ParamValues } from '@/features/params/schema';
import { type JobFailure, type JobState, reduceJob, submittingJob, withFailure } from '@/lib/jobs';
import type {
  JobEvent,
  Narration,
  NarrationFormat,
  NarrationResult,
  NarrationSummary,
  Pauses,
  ReadingResult,
  SplitRules,
} from '@/lib/types';

/** Narration settings as the form edits them (see features/narration/settings.ts). */
export interface SettingsDraft {
  voiceId: string | null;
  caption: string;
  values: ParamValues;
  loraPath: string | null;
  pauses: Pauses;
  voiceLock: boolean;
  applyDictionary: boolean;
}

export interface RenderJob extends JobState<NarrationResult> {
  chunks: { done: number; total: number } | null;
  /** Sampling steps of the chunk being rendered. */
  steps: { done: number; total: number } | null;
}

export const DEFAULT_RULES: SplitRules = { min_chars: 80, max_chars: 150 };
export const DEFAULT_PAUSES: Pauses = { sentence_ms: 400, paragraph_ms: 900 };

export const emptyDraft = (): SettingsDraft => ({
  voiceId: null,
  caption: '',
  values: {},
  loraPath: null,
  pauses: DEFAULT_PAUSES,
  voiceLock: true,
  applyDictionary: true,
});

export const readingKey = (text: string, applyDictionary: boolean) =>
  `${applyDictionary ? 1 : 0}:${text}`;

interface NarrationStore {
  source: string;
  format: NarrationFormat;
  rules: SplitRules;
  narration: Narration | null;
  recent: NarrationSummary[] | null;
  draft: SettingsDraft;
  settingsDirty: boolean;
  invalid: Partial<Record<ParamName, true>>;
  job: RenderJob | null;
  readings: Record<string, ReadingResult>;
  showReadings: boolean;

  setSource: (source: string, format?: NarrationFormat) => void;
  setFormat: (format: NarrationFormat) => void;
  setRules: (rules: SplitRules) => void;
  /** Show a narration from the sidecar, with its settings as the form's draft. */
  open: (narration: Narration, draft: SettingsDraft) => void;
  /** Newer state of the open narration (the draft stays). */
  replace: (narration: Narration) => void;
  startNew: () => void;
  setRecent: (recent: NarrationSummary[]) => void;
  updateDraft: (patch: Partial<SettingsDraft>) => void;
  setParam: (name: ParamName, value: ParamValue, defaultValue: ParamValue) => void;
  setInvalid: (name: ParamName, invalid: boolean) => void;
  settingsSaved: (narration: Narration) => void;

  beginJob: () => void;
  /** `chunks`: how many chunks the job will render, when known. */
  jobAccepted: (id: string, position: number, chunks?: number) => void;
  applyEvent: (event: JobEvent<NarrationResult>) => void;
  failJob: (failure: JobFailure) => void;

  setReading: (key: string, reading: ReadingResult) => void;
  clearReadings: () => void;
  setShowReadings: (show: boolean) => void;
}

export const useNarrationStore = create<NarrationStore>((set) => ({
  source: '',
  format: 'text',
  rules: DEFAULT_RULES,
  narration: null,
  recent: null,
  draft: emptyDraft(),
  settingsDirty: false,
  invalid: {},
  job: null,
  readings: {},
  showReadings: false,

  setSource: (source, format) => set((s) => ({ source, format: format ?? s.format })),
  setFormat: (format) => set({ format }),
  setRules: (rules) => set({ rules }),
  open: (narration, draft) =>
    set((s) => ({
      narration,
      source: narration.source,
      format: narration.format,
      rules: narration.rules,
      draft,
      settingsDirty: false,
      invalid: {},
      // Reopening the same narration keeps following its render.
      job: s.narration?.id === narration.id ? s.job : null,
    })),
  replace: (narration) => set({ narration }),
  startNew: () =>
    set({
      narration: null,
      source: '',
      format: 'text',
      rules: DEFAULT_RULES,
      draft: emptyDraft(),
      settingsDirty: false,
      invalid: {},
      job: null,
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
  settingsSaved: (narration) => set({ narration, settingsDirty: false }),

  beginJob: () => set({ job: { ...submittingJob<NarrationResult>(), chunks: null, steps: null } }),
  jobAccepted: (id, position, chunks) =>
    set((s) => {
      if (!s.job) return {};
      const progress = chunks ? { done: 0, total: chunks } : s.job.chunks;
      return { job: { ...s.job, id, phase: 'queued', position, chunks: progress } };
    }),
  applyEvent: (event) =>
    set((s) => {
      if (!s.job) return {};
      let job = reduceJob(s.job, event);
      let narration = s.narration;
      if (event.type === 'progress') {
        const progress = { done: event.data.done, total: event.data.total };
        job =
          event.data.unit === 'chunk'
            ? { ...job, chunks: progress, steps: null }
            : { ...job, steps: progress };
      }
      if (event.type === 'chunk' && narration) {
        const { index, takes, adopted_audio_id } = event.data;
        const chunks = narration.chunks.map((chunk) =>
          chunk.index === index
            ? { ...chunk, takes: [...chunk.takes, ...takes], adopted_audio_id }
            : chunk,
        );
        narration = { ...narration, chunks, assembled: null };
      }
      return { job, narration };
    }),
  failJob: (failure) => set((s) => (s.job ? { job: withFailure(s.job, failure) } : {})),

  setReading: (key, reading) => set((s) => ({ readings: { ...s.readings, [key]: reading } })),
  clearReadings: () => set({ readings: {} }),
  setShowReadings: (showReadings) => set({ showReadings }),
}));
