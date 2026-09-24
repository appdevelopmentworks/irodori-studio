// Starts, follows and cancels the Quick screen's generation job. The SSE stream lives
// outside React so the job keeps updating while the user is on another screen.
import { failureOf } from '@/lib/jobs';
import { subscribeJob } from '@/lib/sse';
import type { SynthesisRequest } from '@/lib/types';
import { useQuickStore } from '@/store/quick';
import { useSidecarStore } from '@/store/sidecar';

let stopStream: (() => void) | null = null;

export async function startGeneration(request: SynthesisRequest): Promise<void> {
  const api = useSidecarStore.getState().api;
  if (!api) return;
  stopStream?.();
  stopStream = null;
  const quick = useQuickStore.getState();
  quick.beginJob();
  try {
    const accepted = await api.generate(request);
    quick.jobAccepted(accepted.job_id, accepted.queue_position);
    stopStream = subscribeJob(api.jobEventsUrl(accepted.job_id), {
      onEvent: (event) => useQuickStore.getState().applyEvent(event),
      onError: () => useQuickStore.getState().failJob({ code: 'job_not_found' }),
    });
  } catch (err) {
    quick.failJob(failureOf(err));
  }
}

export async function cancelGeneration(): Promise<void> {
  const api = useSidecarStore.getState().api;
  const jobId = useQuickStore.getState().job?.id;
  if (api && jobId) await api.cancelJob(jobId).catch(() => undefined);
}
