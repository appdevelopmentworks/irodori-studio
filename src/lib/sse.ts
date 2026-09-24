// Job event streams (`GET /jobs/{id}/events`, docs/api-spec.md). The sidecar replays a
// job's events to every new subscriber and ends the stream after the terminal event;
// on a dropped connection EventSource reconnects with Last-Event-ID and resumes.
import type { JobEvent, JobEventType } from './types';

const EVENT_TYPES: JobEventType[] = [
  'queued',
  'started',
  'log',
  'progress',
  'candidate',
  'completed',
  'failed',
  'cancelled',
];
const TERMINAL = new Set<JobEventType>(['completed', 'failed', 'cancelled']);

export interface JobStreamHandlers {
  onEvent: (event: JobEvent) => void;
  /** The stream could not be opened or broke off for good (e.g. unknown job). */
  onError?: () => void;
}

/** Follows a job until its terminal event; returns a function that stops listening. */
export function subscribeJob(url: string, { onEvent, onError }: JobStreamHandlers): () => void {
  const source = new EventSource(url);
  let finished = false;
  const close = () => {
    finished = true;
    source.close();
  };

  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (message) => {
      if (finished) return;
      const data: unknown = JSON.parse((message as MessageEvent<string>).data);
      onEvent({ type, data } as JobEvent);
      if (TERMINAL.has(type)) close();
    });
  }
  source.onerror = () => {
    // CLOSED: the server refused the stream (404) — EventSource will not retry.
    if (!finished && source.readyState === EventSource.CLOSED) {
      finished = true;
      onError?.();
    }
  };
  return close;
}
