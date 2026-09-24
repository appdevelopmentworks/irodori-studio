// Job event streams (`GET /jobs/{id}/events`, docs/api-spec.md). The sidecar replays a
// job's events to every new subscriber and ends the stream after the terminal event;
// on a dropped connection EventSource reconnects with Last-Event-ID and resumes.
import type { JobEvent, JobEventType, TtsResult } from './types';

const EVENT_TYPES: JobEventType[] = [
  'queued',
  'started',
  'log',
  'progress',
  'candidate',
  'chunk',
  'completed',
  'failed',
  'cancelled',
];
const TERMINAL = new Set<JobEventType>(['completed', 'failed', 'cancelled']);

export interface JobStreamHandlers<R> {
  onEvent: (event: JobEvent<R>) => void;
  /** The stream could not be opened or broke off for good (e.g. unknown job). */
  onError?: () => void;
}

/** Follows a job until its terminal event; returns a function that stops listening.
 * `R` is the job's result (`TtsResult` for generations, `EncodeResult` for encoding). */
export function subscribeJob<R = TtsResult>(
  url: string,
  { onEvent, onError }: JobStreamHandlers<R>,
): () => void {
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
      onEvent({ type, data } as JobEvent<R>);
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
