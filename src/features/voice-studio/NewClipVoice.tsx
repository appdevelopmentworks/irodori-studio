'use client';

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { button, card, input, primaryButton } from '@/components/ui';
import { codeOf } from '@/lib/jobs';
import type { ModelCapabilities } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { ClipList } from './ClipList';
import {
  addToDraft,
  discardDraft,
  editDraftClip,
  moved,
  removeDraftClip,
} from './clipOps';
import { ConsentBox, useConsentInput } from './ConsentBox';
import { applySaved } from './jobs';

let takes = 0;

/** A new voice from audio files (b) or microphone recordings (c) of a real person:
 * gather and edit clips, confirm consent (D13), save. */
export function NewClipVoice({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const nameId = useId();
  const api = useSidecarStore((s) => s.api);
  const draft = useVoicesStore((s) => s.clipDraft);
  const update = useVoicesStore((s) => s.updateClipDraft);
  const consentInput = useConsentInput();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api || !draft) return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const uploading = draft.pending.some((p) => p.error === null);
  let problem: string | null = null;
  if (!draft.name.trim()) problem = t('voiceStudio.new.problems.needName');
  else if (uploading) problem = t('voiceStudio.new.problems.uploading');
  else if (draft.clips.length === 0) problem = t('voiceStudio.new.problems.needClips');
  else if (!draft.consent) problem = t('voiceStudio.new.problems.needConsent');

  const save = () =>
    run(async () => {
      const saved = await api.createVoice({
        name: draft.name.trim(),
        source: draft.source,
        clip_ids: draft.clips.map((clip) => clip.clip_id),
        consent: consentInput(),
      });
      const store = useVoicesStore.getState();
      store.discardClipDraft();
      applySaved(saved);
      store.open({ kind: 'voice', voiceId: saved.voice.id });
    });

  const cancel = () =>
    run(async () => {
      await discardDraft(api);
      useVoicesStore.getState().open({ kind: 'none' });
    });

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">
          {t(`voiceStudio.new.titles.${draft.source}`)}
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {t(`voiceStudio.new.intros.${draft.source}`)}
        </p>
      </div>

      <div className={`${card} space-y-4`}>
        <div className="space-y-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t('voiceStudio.fields.name')}
          </label>
          <input
            id={nameId}
            value={draft.name}
            maxLength={100}
            placeholder={t('voiceStudio.fields.namePlaceholder')}
            onChange={(event) => update({ name: event.target.value })}
            className={input}
          />
        </div>

        <section className="space-y-2">
          <p className="text-sm font-medium">{t('voiceStudio.clips.title')}</p>
          <p className="text-xs text-zinc-500">{t('voiceStudio.clips.hint')}</p>
          <ClipList
            clips={draft.clips}
            pending={draft.pending}
            audioUrl={api.clipAudioUrl}
            maxRefSeconds={model.capabilities.max_ref_seconds}
            maxClips={model.limits.max_clips}
            busy={busy}
            recordOpen={draft.source === 'recorded'}
            actions={{
              move: (clipId, delta) => {
                const index = draft.clips.findIndex((c) => c.clip_id === clipId);
                update({ clips: moved(draft.clips, index, delta) });
              },
              remove: (clipId) => void run(() => removeDraftClip(api, clipId)),
              trim: (clipId, start, end) =>
                void run(() => editDraftClip(api, clipId, { trim: [start, end] })),
              split: (clipId, at) => void run(() => editDraftClip(api, clipId, { split: at })),
              dismissPending: (key) => useVoicesStore.getState().dismissPending(key),
              addFiles: (files) =>
                void addToDraft(
                  api,
                  files.map((file) => ({ blob: file, filename: file.name })),
                  'upload',
                ),
              addRecording: (wav) =>
                addToDraft(
                  api,
                  [{ blob: wav, filename: t('voiceStudio.record.takeName', { index: ++takes }) }],
                  'recording',
                ),
            }}
          />
        </section>

        <ConsentBox checked={draft.consent} onChange={(consent) => update({ consent })} />
      </div>

      {error ? <ErrorNotice error={{ code: error }} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || problem !== null}
          onClick={() => void save()}
          className={primaryButton}
        >
          {t('voiceStudio.new.save')}
        </button>
        <button type="button" disabled={busy} onClick={() => void cancel()} className={button}>
          {t('voiceStudio.new.discard')}
        </button>
        {problem ? <p className="text-sm text-amber-700 dark:text-amber-300">{problem}</p> : null}
      </div>
    </div>
  );
}
