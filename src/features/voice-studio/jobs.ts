// Jobs the Voice Studio starts on the shared synthesis queue (D24): design candidates,
// auditions and encoding. The SSE streams live outside React so a job keeps updating while
// the user is on another screen.
import { failureOf } from '@/lib/jobs';
import { subscribeJob } from '@/lib/sse';
import type { EncodeResult, SynthesisRequest, VoiceSaved } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

const voices = useVoicesStore.getState;

let stopDesign: (() => void) | null = null;
let stopAudition: (() => void) | null = null;
const encodeStreams = new Map<string, () => void>();

export async function startDesign(request: SynthesisRequest): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  stopDesign?.();
  stopDesign = null;
  voices().beginDesignJob();
  try {
    const accepted = await api.generate(request);
    voices().designJobAccepted(accepted.job_id, accepted.queue_position);
    stopDesign = subscribeJob(api.jobEventsUrl(accepted.job_id), {
      onEvent: (event) => voices().applyDesignEvent(event),
      onError: () => voices().failDesignJob({ code: 'job_not_found' }),
    });
  } catch (err) {
    voices().failDesignJob(failureOf(err));
  }
}

export async function startAudition(voiceId: string, request: SynthesisRequest): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  stopAudition?.();
  stopAudition = null;
  voices().beginAudition(voiceId);
  try {
    const accepted = await api.generate(request);
    voices().auditionAccepted(accepted.job_id, accepted.queue_position);
    stopAudition = subscribeJob(api.jobEventsUrl(accepted.job_id), {
      onEvent: (event) => voices().applyAuditionEvent(event),
      onError: () => voices().failAudition({ code: 'job_not_found' }),
    });
  } catch (err) {
    voices().failAudition(failureOf(err));
  }
}

export async function cancelJob(jobId: string | null | undefined): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (api && jobId) await api.cancelJob(jobId).catch(() => undefined);
}

/** Follow a voice's encode job; the voice is re-read when it finishes. */
export function followEncode(voiceId: string, jobId: string): void {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  encodeStreams.get(voiceId)?.();
  const status = { jobId, done: 0, total: 0, error: null };
  voices().setEncode(voiceId, { ...status, phase: 'queued' });
  const stop = subscribeJob<EncodeResult>(api.jobEventsUrl(jobId), {
    onEvent: (event) => {
      const current = voices().encoding[voiceId];
      if (current?.jobId !== jobId) return;
      switch (event.type) {
        case 'started':
          voices().setEncode(voiceId, { ...current, phase: 'running' });
          break;
        case 'progress':
          voices().setEncode(voiceId, {
            ...current,
            phase: 'running',
            done: event.data.done,
            total: event.data.total,
          });
          break;
        case 'failed':
          voices().setEncode(voiceId, { ...current, phase: 'failed', error: event.data.code });
          break;
        case 'completed':
        case 'cancelled':
          // Clear the status once the fresh voice (with `encoded`) is in the store.
          void voices()
            .refresh(voiceId)
            .finally(() => {
              if (voices().encoding[voiceId]?.jobId === jobId) voices().setEncode(voiceId, null);
            });
          break;
        default:
          break;
      }
    },
    onError: () => {
      const current = voices().encoding[voiceId];
      if (current?.jobId === jobId) {
        voices().setEncode(voiceId, { ...current, phase: 'failed', error: 'job_not_found' });
      }
    },
  });
  encodeStreams.set(voiceId, stop);
}

/** Store a saved voice and follow its encode job, if the save queued one. */
export function applySaved(saved: VoiceSaved): void {
  voices().upsert(saved.voice);
  if (saved.encode_job_id) followEncode(saved.voice.id, saved.encode_job_id);
}

/** Queue encoding for a voice whose clips changed outside a save (trim, split). */
export async function encodeVoice(voiceId: string): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  try {
    const job = await api.encodeVoice(voiceId);
    if (job) followEncode(voiceId, job.job_id);
    else await voices().refresh(voiceId);
  } catch {
    await voices().refresh(voiceId);
  }
}
