// Clip edits for the Voice Studio. A draft (a new voice before its first save) holds
// unowned clips in the store; a saved voice changes on the sidecar right away and is
// re-encoded afterwards ("encode on save").
import type { Api } from '@/lib/api';
import { codeOf } from '@/lib/jobs';
import type { ClipInfo, ConsentInput, Voice, VoicePatch } from '@/lib/types';
import { useVoicesStore } from '@/store/voices';

import { applySaved, encodeVoice } from './jobs';

let counter = 0;
const nextKey = () => `pending-${++counter}`;

const voices = useVoicesStore.getState;

/** Upload files or a recording into the draft. */
export async function addToDraft(
  api: Api,
  items: { blob: Blob; filename: string }[],
  origin: 'upload' | 'recording',
): Promise<void> {
  for (const item of items) {
    const key = nextKey();
    voices().addPending({ key, filename: item.filename, error: null });
    try {
      voices().finishPending(key, await api.uploadClip(item.blob, item.filename, origin));
    } catch (err) {
      voices().failPending(key, codeOf(err));
    }
  }
}

/** Trim or split a draft clip; the new clips take its place. */
export async function editDraftClip(
  api: Api,
  clipId: string,
  edit: { trim: [number, number] } | { split: number },
): Promise<void> {
  const clips: ClipInfo[] =
    'trim' in edit
      ? [await api.trimClip(clipId, edit.trim[0], edit.trim[1])]
      : await api.splitClip(clipId, [edit.split]);
  voices().replaceDraftClip(clipId, clips);
}

/** Remove a draft clip and delete it on the sidecar (it is not in any voice yet). */
export async function removeDraftClip(api: Api, clipId: string): Promise<void> {
  const draft = voices().clipDraft;
  if (!draft) return;
  voices().updateClipDraft({ clips: draft.clips.filter((c) => c.clip_id !== clipId) });
  await api.deleteClip(clipId).catch(() => undefined);
}

/** Drop the draft and the clips uploaded for it. */
export async function discardDraft(api: Api): Promise<void> {
  const draft = voices().clipDraft;
  voices().discardClipDraft();
  for (const clip of draft?.clips ?? []) {
    await api.deleteClip(clip.clip_id).catch(() => undefined);
  }
}

export const moved = <T>(items: T[], index: number, delta: -1 | 1): T[] => {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

/** Set a saved voice's clips (order, removals, additions). Clips it no longer lists are
 * deleted by the sidecar. `consent` is required when real-voice clips join a voice
 * that has no consent record yet. */
export async function setVoiceClips(
  api: Api,
  voice: Voice,
  clipIds: string[],
  consent?: ConsentInput,
): Promise<void> {
  const patch: VoicePatch = { clip_ids: clipIds };
  if (consent) patch.consent = consent;
  applySaved(await api.updateVoice(voice.id, patch));
}

/** Trim or split a saved voice's clip (the sidecar swaps it inside the voice), then
 * re-encode the voice. */
export async function editVoiceClip(
  api: Api,
  voice: Voice,
  clipId: string,
  edit: { trim: [number, number] } | { split: number },
): Promise<void> {
  if ('trim' in edit) await api.trimClip(clipId, edit.trim[0], edit.trim[1]);
  else await api.splitClip(clipId, [edit.split]);
  await voices().refresh(voice.id);
  await encodeVoice(voice.id);
}
