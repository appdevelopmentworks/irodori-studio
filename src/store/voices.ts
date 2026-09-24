// Voice Studio state: the voice library (read from the sidecar), what the studio shows,
// unsaved drafts of new voices, and the jobs it started (design candidates, auditions,
// encoding). Kept while the user switches screens; memory only (D11).
import { create } from 'zustand';

import type { ParamName, ParamValue, ParamValues } from '@/features/params/schema';
import {
  codeOf,
  type JobFailure,
  type JobState,
  reduceJob,
  submittingJob,
  withFailure,
} from '@/lib/jobs';
import type { ClipInfo, JobEvent, TtsResult, Voice, VoiceSource } from '@/lib/types';

import { useSidecarStore } from './sidecar';

export type StudioPanel =
  | { kind: 'none' }
  | { kind: 'voice'; voiceId: string }
  | { kind: 'new'; source: VoiceSource };

/** Sources whose reference is audio of a real person (consent required, D13). */
export type ClipSource = 'imported' | 'recorded';

/** An upload or recording on its way to becoming a clip. */
export interface PendingClip {
  key: string;
  filename: string;
  /** Error code when it failed; the entry stays until dismissed. */
  error: string | null;
}

export interface EncodeStatus {
  jobId: string;
  phase: 'queued' | 'running' | 'failed';
  done: number;
  total: number;
  error: string | null;
}

/** A new voice from audio files or recordings, before it is saved. */
export interface ClipDraft {
  source: ClipSource;
  name: string;
  clips: ClipInfo[];
  pending: PendingClip[];
  consent: boolean;
}

/** Designing a voice by caption: generate candidates, choose one, save it. */
export interface DesignDraft {
  name: string;
  caption: string;
  text: string;
  values: ParamValues;
  invalid: Partial<Record<ParamName, true>>;
  job: JobState<TtsResult> | null;
  chosenAudioId: string | null;
  /** Keep the chosen candidate as the voice's reference clip (else caption only). */
  keepAudio: boolean;
}

export interface EmbeddingDraft {
  name: string;
  path: string | null;
}

/** A test generation with a voice (or its unsaved defaults). */
export interface Audition {
  voiceId: string;
  job: JobState<TtsResult>;
  /** A fresh result waits to be played once. */
  autoplay: boolean;
}

const emptyDesign = (text: string): DesignDraft => ({
  name: '',
  caption: '',
  text,
  values: {},
  invalid: {},
  job: null,
  chosenAudioId: null,
  keepAudio: true,
});

interface VoicesStore {
  voices: Voice[] | null;
  loadError: string | null;
  panel: StudioPanel;
  encoding: Record<string, EncodeStatus>;
  clipDraft: ClipDraft | null;
  design: DesignDraft;
  embeddingDraft: EmbeddingDraft;
  audition: Audition | null;

  load: () => Promise<void>;
  /** Re-read one voice (after edits or encoding). */
  refresh: (voiceId: string) => Promise<void>;
  upsert: (voice: Voice) => void;
  forget: (voiceId: string) => void;
  open: (panel: StudioPanel) => void;

  setEncode: (voiceId: string, status: EncodeStatus | null) => void;

  startClipDraft: (source: ClipSource) => void;
  updateClipDraft: (patch: Partial<Omit<ClipDraft, 'source'>>) => void;
  addPending: (pending: PendingClip) => void;
  finishPending: (key: string, clip: ClipInfo) => void;
  failPending: (key: string, error: string) => void;
  dismissPending: (key: string) => void;
  /** Replace one draft clip with the clips an edit produced (trim, split). */
  replaceDraftClip: (clipId: string, clips: ClipInfo[]) => void;
  discardClipDraft: () => void;

  seedDesign: (text: string) => void;
  updateDesign: (patch: Partial<Omit<DesignDraft, 'job' | 'values' | 'invalid'>>) => void;
  setDesignParam: (name: ParamName, value: ParamValue, defaultValue: ParamValue) => void;
  setDesignInvalid: (name: ParamName, invalid: boolean) => void;
  beginDesignJob: () => void;
  designJobAccepted: (id: string, position: number) => void;
  applyDesignEvent: (event: JobEvent) => void;
  failDesignJob: (failure: JobFailure) => void;
  resetDesign: (text: string) => void;

  updateEmbeddingDraft: (patch: Partial<EmbeddingDraft>) => void;

  beginAudition: (voiceId: string) => void;
  auditionAccepted: (id: string, position: number) => void;
  applyAuditionEvent: (event: JobEvent) => void;
  failAudition: (failure: JobFailure) => void;
  consumeAuditionAutoplay: () => void;
}

const byNewest = (a: Voice, b: Voice) =>
  b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

export const useVoicesStore = create<VoicesStore>((set, get) => ({
  voices: null,
  loadError: null,
  panel: { kind: 'none' },
  encoding: {},
  clipDraft: null,
  design: emptyDesign(''),
  embeddingDraft: { name: '', path: null },
  audition: null,

  load: async () => {
    const api = useSidecarStore.getState().api;
    if (!api) return;
    try {
      const voices = await api.listVoices();
      set({ voices, loadError: null });
    } catch (err) {
      set({ loadError: codeOf(err) });
    }
  },
  refresh: async (voiceId) => {
    const api = useSidecarStore.getState().api;
    if (!api) return;
    try {
      get().upsert(await api.getVoice(voiceId));
    } catch {
      // Deleted meanwhile: the next list load drops it.
    }
  },
  upsert: (voice) =>
    set((s) => {
      const others = (s.voices ?? []).filter((v) => v.id !== voice.id);
      return { voices: [...others, voice].sort(byNewest) };
    }),
  forget: (voiceId) =>
    set((s) => {
      const encoding = { ...s.encoding };
      delete encoding[voiceId];
      return {
        voices: (s.voices ?? []).filter((v) => v.id !== voiceId),
        encoding,
        panel:
          s.panel.kind === 'voice' && s.panel.voiceId === voiceId ? { kind: 'none' } : s.panel,
        audition: s.audition?.voiceId === voiceId ? null : s.audition,
      };
    }),
  open: (panel) => set({ panel }),

  setEncode: (voiceId, status) =>
    set((s) => {
      const encoding = { ...s.encoding };
      if (status) encoding[voiceId] = status;
      else delete encoding[voiceId];
      return { encoding };
    }),

  startClipDraft: (source) =>
    set((s) => {
      if (s.clipDraft?.source === source) return {};
      // Switching between files and recording keeps the clips gathered so far.
      const clips = s.clipDraft?.clips ?? [];
      const name = s.clipDraft?.name ?? '';
      return { clipDraft: { source, name, clips, pending: [], consent: false } };
    }),
  updateClipDraft: (patch) =>
    set((s) => (s.clipDraft ? { clipDraft: { ...s.clipDraft, ...patch } } : {})),
  addPending: (pending) =>
    set((s) => {
      if (!s.clipDraft) return {};
      return { clipDraft: { ...s.clipDraft, pending: [...s.clipDraft.pending, pending] } };
    }),
  finishPending: (key, clip) =>
    set((s) =>
      s.clipDraft
        ? {
            clipDraft: {
              ...s.clipDraft,
              pending: s.clipDraft.pending.filter((p) => p.key !== key),
              clips: [...s.clipDraft.clips, clip],
            },
          }
        : {},
    ),
  failPending: (key, error) =>
    set((s) =>
      s.clipDraft
        ? {
            clipDraft: {
              ...s.clipDraft,
              pending: s.clipDraft.pending.map((p) => (p.key === key ? { ...p, error } : p)),
            },
          }
        : {},
    ),
  dismissPending: (key) =>
    set((s) => {
      if (!s.clipDraft) return {};
      const pending = s.clipDraft.pending.filter((p) => p.key !== key);
      return { clipDraft: { ...s.clipDraft, pending } };
    }),
  replaceDraftClip: (clipId, clips) =>
    set((s) => {
      if (!s.clipDraft) return {};
      const index = s.clipDraft.clips.findIndex((c) => c.clip_id === clipId);
      if (index < 0) return {};
      const next = [...s.clipDraft.clips];
      next.splice(index, 1, ...clips);
      return { clipDraft: { ...s.clipDraft, clips: next } };
    }),
  discardClipDraft: () => set({ clipDraft: null }),

  seedDesign: (text) =>
    set((s) => (s.design.text || s.design.job ? {} : { design: { ...s.design, text } })),
  updateDesign: (patch) => set((s) => ({ design: { ...s.design, ...patch } })),
  setDesignParam: (name, value, defaultValue) =>
    set((s) => {
      const values = { ...s.design.values };
      if (value === defaultValue) delete values[name];
      else values[name] = value;
      return { design: { ...s.design, values } };
    }),
  setDesignInvalid: (name, invalid) =>
    set((s) => {
      if (Boolean(s.design.invalid[name]) === invalid) return {};
      const next = { ...s.design.invalid };
      if (invalid) next[name] = true;
      else delete next[name];
      return { design: { ...s.design, invalid: next } };
    }),
  beginDesignJob: () =>
    set((s) => ({ design: { ...s.design, job: submittingJob(), chosenAudioId: null } })),
  designJobAccepted: (id, position) =>
    set((s) => {
      if (!s.design.job) return {};
      const job = { ...s.design.job, id, phase: 'queued' as const, position };
      return { design: { ...s.design, job } };
    }),
  applyDesignEvent: (event) =>
    set((s) => {
      if (!s.design.job) return {};
      const job = reduceJob(s.design.job, event);
      // Preselect the first candidate so a single candidate can be saved right away.
      const chosenAudioId =
        event.type === 'completed'
          ? (event.data.outputs[0]?.audio_id ?? null)
          : s.design.chosenAudioId;
      return { design: { ...s.design, job, chosenAudioId } };
    }),
  failDesignJob: (failure) =>
    set((s) => {
      if (!s.design.job) return {};
      return { design: { ...s.design, job: withFailure(s.design.job, failure) } };
    }),
  resetDesign: (text) => set({ design: emptyDesign(text) }),

  updateEmbeddingDraft: (patch) =>
    set((s) => ({ embeddingDraft: { ...s.embeddingDraft, ...patch } })),

  beginAudition: (voiceId) =>
    set({ audition: { voiceId, job: submittingJob(), autoplay: false } }),
  auditionAccepted: (id, position) =>
    set((s) => {
      if (!s.audition) return {};
      const job = { ...s.audition.job, id, phase: 'queued' as const, position };
      return { audition: { ...s.audition, job } };
    }),
  applyAuditionEvent: (event) =>
    set((s) => {
      if (!s.audition) return {};
      const job = reduceJob(s.audition.job, event);
      return { audition: { ...s.audition, job, autoplay: event.type === 'completed' } };
    }),
  failAudition: (failure) =>
    set((s) => {
      if (!s.audition) return {};
      return { audition: { ...s.audition, job: withFailure(s.audition.job, failure) } };
    }),
  consumeAuditionAutoplay: () =>
    set((s) => (s.audition?.autoplay ? { audition: { ...s.audition, autoplay: false } } : {})),
}));
