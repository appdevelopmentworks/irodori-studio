// Client-side state of one queued job (a generation or a voice encoding), advanced by the
// job's SSE events (sse.ts). Stores keep it, so a job keeps updating while the user is on
// another screen.
import { ApiError } from './api';
import type { JobEvent, TtsResult } from './types';

export type JobPhase = 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobFailure {
  code: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export interface JobState<R = TtsResult> {
  id: string | null;
  phase: JobPhase;
  position: number;
  progress: { done: number; total: number } | null;
  logs: string[];
  result: R | null;
  error: JobFailure | null;
  startedAt: number;
  finishedAt: number | null;
}

const MAX_LOG_LINES = 1000;
const BUSY = new Set<JobPhase>(['submitting', 'queued', 'running']);

export const isBusy = (job: { phase: JobPhase } | null | undefined): boolean =>
  job != null && BUSY.has(job.phase);

/** A job being submitted (no id yet). */
export const submittingJob = <R = TtsResult>(): JobState<R> => ({
  id: null,
  phase: 'submitting',
  position: 0,
  progress: null,
  logs: [],
  result: null,
  error: null,
  startedAt: Date.now(),
  finishedAt: null,
});

export function reduceJob<R, J extends JobState<R>>(job: J, event: JobEvent<R>): J {
  switch (event.type) {
    case 'queued':
      return { ...job, phase: 'queued', position: event.data.position };
    case 'started':
      return { ...job, phase: 'running' };
    case 'progress':
      return { ...job, progress: { done: event.data.done, total: event.data.total } };
    case 'log':
      return { ...job, logs: [...job.logs.slice(-(MAX_LOG_LINES - 1)), event.data.line] };
    case 'candidate':
    case 'chunk':
      return job;
    case 'completed':
      return { ...job, phase: 'completed', result: event.data, finishedAt: Date.now() };
    case 'failed':
      return {
        ...job,
        phase: 'failed',
        error: { code: event.data.code, message: event.data.message },
        finishedAt: Date.now(),
      };
    case 'cancelled':
      return { ...job, phase: 'cancelled', finishedAt: Date.now() };
  }
}

export const withFailure = <J extends JobState<unknown>>(job: J, error: JobFailure): J => ({
  ...job,
  phase: 'failed',
  error,
  finishedAt: Date.now(),
});

/** The failure a rejected API call stands for. */
export const failureOf = (err: unknown): JobFailure =>
  err instanceof ApiError ? { code: err.code, detail: err.detail } : { code: 'internal' };

/** The error code of a rejected API call. */
export const codeOf = (err: unknown): string => (err instanceof ApiError ? err.code : 'internal');
