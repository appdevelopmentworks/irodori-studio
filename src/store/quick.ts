// Quick screen state: the form (text, caption, voice, parameter overrides) and the
// current generation job, kept while the user switches screens. Memory only (D11).
import { create } from 'zustand';

import type { ParamName, ParamValue, ParamValues, ReferenceKind } from '@/features/params/schema';
import type { AudioFormat, ClipInfo, JobEvent, TtsResult } from '@/lib/types';

export type JobPhase = 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobFailure {
  code: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export interface QuickJob {
  id: string | null;
  phase: JobPhase;
  position: number;
  progress: { done: number; total: number } | null;
  logs: string[];
  result: TtsResult | null;
  error: JobFailure | null;
  adoptedAudioId: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** A fresh result waits to be played once. */
  autoplay: boolean;
}

export interface ClipUpload {
  key: string;
  filename: string;
  /** Error code when the upload failed; the entry stays until dismissed. */
  error: string | null;
}

const MAX_LOG_LINES = 1000;

interface QuickStore {
  text: string;
  textSeeded: boolean;
  caption: string;
  reference: ReferenceKind;
  clips: ClipInfo[];
  uploads: ClipUpload[];
  embeddingPath: string | null;
  loraPath: string | null;
  values: ParamValues;
  invalid: Partial<Record<ParamName, true>>;
  job: QuickJob | null;
  /** audio_id → path of the last saved copy. */
  saved: Record<string, string>;
  saveFormat: AudioFormat;

  seedText: (text: string) => void;
  setText: (text: string) => void;
  setCaption: (caption: string) => void;
  setReference: (reference: ReferenceKind) => void;
  addUpload: (upload: ClipUpload) => void;
  finishUpload: (key: string, clip: ClipInfo) => void;
  failUpload: (key: string, error: string) => void;
  dismissUpload: (key: string) => void;
  moveClip: (clipId: string, delta: -1 | 1) => void;
  removeClip: (clipId: string) => void;
  setEmbeddingPath: (path: string | null) => void;
  setLoraPath: (path: string | null) => void;
  setParam: (name: ParamName, value: ParamValue, defaultValue: ParamValue) => void;
  resetParams: () => void;
  setInvalid: (name: ParamName, invalid: boolean) => void;
  beginJob: () => void;
  jobAccepted: (id: string, position: number) => void;
  applyEvent: (event: JobEvent) => void;
  failJob: (failure: JobFailure) => void;
  setAdopted: (audioId: string | null) => void;
  markSaved: (audioId: string, path: string) => void;
  consumeAutoplay: () => void;
  setSaveFormat: (format: AudioFormat) => void;
}

const updateJob = (job: QuickJob | null, patch: Partial<QuickJob>): QuickJob | null =>
  job ? { ...job, ...patch } : job;

export const useQuickStore = create<QuickStore>((set) => ({
  text: '',
  textSeeded: false,
  caption: '',
  reference: 'none',
  clips: [],
  uploads: [],
  embeddingPath: null,
  loraPath: null,
  values: {},
  invalid: {},
  job: null,
  saved: {},
  saveFormat: 'wav',

  seedText: (text) => set((s) => (s.textSeeded ? {} : { text, textSeeded: true })),
  setText: (text) => set({ text, textSeeded: true }),
  setCaption: (caption) => set({ caption }),
  setReference: (reference) => set({ reference }),
  addUpload: (upload) => set((s) => ({ uploads: [...s.uploads, upload] })),
  finishUpload: (key, clip) =>
    set((s) => ({
      uploads: s.uploads.filter((u) => u.key !== key),
      clips: [...s.clips, clip],
    })),
  failUpload: (key, error) =>
    set((s) => ({ uploads: s.uploads.map((u) => (u.key === key ? { ...u, error } : u)) })),
  dismissUpload: (key) => set((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) })),
  moveClip: (clipId, delta) =>
    set((s) => {
      const index = s.clips.findIndex((c) => c.clip_id === clipId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= s.clips.length) return {};
      const clips = [...s.clips];
      [clips[index], clips[target]] = [clips[target], clips[index]];
      return { clips };
    }),
  removeClip: (clipId) => set((s) => ({ clips: s.clips.filter((c) => c.clip_id !== clipId) })),
  setEmbeddingPath: (embeddingPath) => set({ embeddingPath }),
  setLoraPath: (loraPath) => set({ loraPath }),
  setParam: (name, value, defaultValue) =>
    set((s) => {
      const values = { ...s.values };
      if (value === defaultValue) delete values[name];
      else values[name] = value;
      return { values };
    }),
  resetParams: () => set({ values: {}, invalid: {} }),
  setInvalid: (name, invalid) =>
    set((s) => {
      if (Boolean(s.invalid[name]) === invalid) return {};
      const next = { ...s.invalid };
      if (invalid) next[name] = true;
      else delete next[name];
      return { invalid: next };
    }),

  beginJob: () =>
    set({
      job: {
        id: null,
        phase: 'submitting',
        position: 0,
        progress: null,
        logs: [],
        result: null,
        error: null,
        adoptedAudioId: null,
        startedAt: Date.now(),
        finishedAt: null,
        autoplay: false,
      },
    }),
  jobAccepted: (id, position) =>
    set((s) => ({ job: updateJob(s.job, { id, phase: 'queued', position }) })),
  applyEvent: (event) =>
    set((s) => {
      const job = s.job;
      if (!job) return {};
      switch (event.type) {
        case 'queued':
          return { job: { ...job, phase: 'queued', position: event.data.position } };
        case 'started':
          return { job: { ...job, phase: 'running' } };
        case 'progress': {
          const { done, total } = event.data;
          return { job: { ...job, progress: { done, total } } };
        }
        case 'log': {
          const logs = [...job.logs.slice(-(MAX_LOG_LINES - 1)), event.data.line];
          return { job: { ...job, logs } };
        }
        case 'candidate':
          return {};
        case 'completed':
          return {
            job: {
              ...job,
              phase: 'completed',
              result: event.data,
              finishedAt: Date.now(),
              autoplay: true,
            },
          };
        case 'failed':
          return {
            job: {
              ...job,
              phase: 'failed',
              error: { code: event.data.code, message: event.data.message },
              finishedAt: Date.now(),
            },
          };
        case 'cancelled':
          return { job: { ...job, phase: 'cancelled', finishedAt: Date.now() } };
      }
    }),
  failJob: (failure) =>
    set((s) => ({
      job: updateJob(s.job, { phase: 'failed', error: failure, finishedAt: Date.now() }),
    })),
  setAdopted: (adoptedAudioId) => set((s) => ({ job: updateJob(s.job, { adoptedAudioId }) })),
  markSaved: (audioId, path) => set((s) => ({ saved: { ...s.saved, [audioId]: path } })),
  consumeAutoplay: () => set((s) => ({ job: updateJob(s.job, { autoplay: false }) })),
  setSaveFormat: (saveFormat) => set({ saveFormat }),
}));
