// Builds the SynthesisRequest from the Quick screen state, and says why it cannot be sent.
import { requestParams } from '@/features/params/schema';
import type { ModelCapabilities, ReferenceInput, SynthesisRequest } from '@/lib/types';
import type { useQuickStore } from '@/store/quick';

type QuickState = ReturnType<typeof useQuickStore.getState>;

export type RequestProblem =
  | 'needText'
  | 'needClips'
  | 'needEmbedding'
  | 'uploading'
  | 'invalidParams';

export function requestProblem(state: QuickState): RequestProblem | null {
  if (!state.text.trim()) return 'needText';
  if (state.reference === 'clips') {
    if (state.uploads.some((u) => u.error === null)) return 'uploading';
    if (state.clips.length === 0) return 'needClips';
  }
  if (state.reference === 'embedding' && !state.embeddingPath) return 'needEmbedding';
  if (Object.keys(state.invalid).length > 0) return 'invalidParams';
  return null;
}

export function buildRequest(state: QuickState, model: ModelCapabilities): SynthesisRequest {
  let reference: ReferenceInput = { kind: 'none' };
  if (state.reference === 'clips') {
    reference = { kind: 'clips', clip_ids: state.clips.map((clip) => clip.clip_id) };
  } else if (state.reference === 'embedding' && state.embeddingPath) {
    reference = { kind: 'embedding', path: state.embeddingPath };
  }
  const request: SynthesisRequest = {
    text: state.text,
    reference,
    params: requestParams(model.params, state.values),
  };
  const caption = state.caption.trim();
  if (caption && model.capabilities.caption) request.caption = caption;
  if (state.loraPath && model.capabilities.lora) request.lora_adapter = state.loraPath;
  return request;
}
