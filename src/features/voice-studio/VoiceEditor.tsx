'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { useEmbeddingPicker } from '@/features/quick/useEmbeddingPicker';
import { formatDateTime } from '@/lib/format';
import { codeOf } from '@/lib/jobs';
import { pickSavePath } from '@/lib/tauri';
import type { ClipInfo, ModelCapabilities, Voice } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';
import { type PendingClip, useVoicesStore } from '@/store/voices';

import { ClipList } from './ClipList';
import { editVoiceClip, moved, setVoiceClips } from './clipOps';
import { ConsentBox, ConsentRecord, useConsentInput } from './ConsentBox';
import { EncodeBadge } from './EncodeBadge';
import { applySaved, encodeVoice } from './jobs';
import { button, card, dangerButton } from './ui';
import { VoiceDefaults } from './VoiceDefaults';

let counter = 0;
let takes = 0;

/** A saved voice: its reference (clips or embedding), consent record, encoding state,
 * defaults with an audition, and the package export. */
export function VoiceEditor({ voice, model }: { voice: Voice; model: ModelCapabilities }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const api = useSidecarStore((s) => s.api);
  const encoding = useVoicesStore((s) => s.encoding[voice.id]);
  const consentInput = useConsentInput();
  const pickEmbedding = useEmbeddingPicker();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingClip[]>([]);
  const [consent, setConsent] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  if (!api) return null;

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

  const ids = voice.clips.map((clip) => clip.clip_id);
  // Real-voice clips joining a voice without a consent record need consent now (D13).
  const needsConsent = voice.consent === null;

  const addClips = async (
    items: { blob: Blob; filename: string }[],
    origin: 'upload' | 'recording',
  ) => {
    const added: ClipInfo[] = [];
    for (const item of items) {
      const key = `voice-pending-${++counter}`;
      setPending((list) => [...list, { key, filename: item.filename, error: null }]);
      try {
        added.push(await api.uploadClip(item.blob, item.filename, origin));
        setPending((list) => list.filter((p) => p.key !== key));
      } catch (err) {
        const code = codeOf(err);
        setPending((list) => list.map((p) => (p.key === key ? { ...p, error: code } : p)));
      }
    }
    if (added.length === 0) return;
    await run(async () => {
      // The clips may have changed while uploading (an edit meanwhile).
      const current = useVoicesStore.getState().voices?.find((v) => v.id === voice.id) ?? voice;
      try {
        await setVoiceClips(
          api,
          current,
          [...current.clips.map((clip) => clip.clip_id), ...added.map((clip) => clip.clip_id)],
          current.consent === null ? consentInput() : undefined,
        );
      } catch (err) {
        // Not attached: the uploads would otherwise linger unowned.
        for (const clip of added) {
          await api.deleteClip(clip.clip_id).catch(() => undefined);
        }
        throw err;
      }
    });
  };

  const replaceEmbedding = async () => {
    const path = await pickEmbedding();
    if (!path) return;
    await run(async () => applySaved(await api.updateVoice(voice.id, { embedding_path: path })));
  };

  const exportPackage = async () => {
    const path = await pickSavePath(
      t('voiceStudio.package.exportTitle'),
      `${voice.name}.irovoice`,
      [{ name: t('voiceStudio.package.filter'), extensions: ['irovoice'] }],
    );
    if (!path) return;
    await run(async () => {
      const file = await api.exportVoice(voice.id, path);
      setExported(file.path);
    });
  };

  const remove = () =>
    run(async () => {
      await api.deleteVoice(voice.id);
      useVoicesStore.getState().forget(voice.id);
    });

  const otherModel = voice.model_id !== model.model_id;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-lg font-semibold tracking-tight">{voice.name}</h2>
          <p className="text-xs text-zinc-500">
            {t('voiceStudio.editor.meta', {
              source: t(`voiceStudio.sources.${voice.source}`),
              date: formatDateTime(voice.created_at, locale),
            })}
          </p>
          {otherModel ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('voiceStudio.editor.otherModel', { model: voice.model_id })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void exportPackage()} className={button}>
            {t('voiceStudio.package.export')}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)} className={dangerButton}>
            {t('voiceStudio.editor.delete')}
          </button>
        </div>
      </div>

      {confirmDelete ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
          <span className="flex-1">{t('voiceStudio.editor.deleteConfirm', { name: voice.name })}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {t('voiceStudio.editor.deleteYes')}
          </button>
          <button type="button" onClick={() => setConfirmDelete(false)} className={button}>
            {t('voiceStudio.common.cancel')}
          </button>
        </div>
      ) : null}

      {exported ? (
        <p className="text-xs break-all text-emerald-700 dark:text-emerald-400">
          {t('voiceStudio.package.exported', { path: exported })}
        </p>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}

      <div className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('voiceStudio.editor.reference')}</h3>
          <EncodeBadge voice={voice} status={encoding} onEncode={() => void encodeVoice(voice.id)} />
        </div>

        {voice.source === 'embedding' ? (
          <div className="space-y-2 text-sm">
            {voice.embedding ? (
              <p>
                {t('voiceStudio.embedding.info', {
                  tokens: voice.embedding.tokens,
                  dim: voice.embedding.dim,
                })}
              </p>
            ) : (
              <p className="text-amber-700 dark:text-amber-300">{t('voiceStudio.embedding.missing')}</p>
            )}
            <button type="button" disabled={busy} onClick={() => void replaceEmbedding()} className={button}>
              {t('voiceStudio.embedding.replace')}
            </button>
          </div>
        ) : (
          <>
            {voice.design_caption ? (
              <p className="text-sm">
                <span className="text-zinc-500">{t('voiceStudio.editor.designCaption')}</span>{' '}
                <span lang="ja">{voice.design_caption}</span>
              </p>
            ) : null}
            {voice.clips.length === 0 && voice.source === 'designed' ? (
              <p className="text-xs text-zinc-500">{t('voiceStudio.editor.captionOnly')}</p>
            ) : null}
            {needsConsent ? (
              <details className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <summary className="cursor-pointer text-sm select-none">
                  {t('voiceStudio.editor.addNeedsConsent')}
                </summary>
                <div className="pt-2">
                  <ConsentBox checked={consent} onChange={setConsent} />
                </div>
              </details>
            ) : null}
            <ClipList
              clips={voice.clips}
              pending={pending}
              audioUrl={api.clipAudioUrl}
              maxRefSeconds={model.capabilities.max_ref_seconds}
              maxClips={model.limits.max_clips}
              busy={busy}
              canAdd={!needsConsent || consent}
              actions={{
                move: (clipId, delta) =>
                  void run(() => setVoiceClips(api, voice, moved(ids, ids.indexOf(clipId), delta))),
                remove: (clipId) =>
                  void run(() => setVoiceClips(api, voice, ids.filter((id) => id !== clipId))),
                trim: (clipId, start, end) =>
                  void run(() => editVoiceClip(api, voice, clipId, { trim: [start, end] })),
                split: (clipId, at) =>
                  void run(() => editVoiceClip(api, voice, clipId, { split: at })),
                dismissPending: (key) => setPending((list) => list.filter((p) => p.key !== key)),
                addFiles: (files) =>
                  void addClips(
                    files.map((file) => ({ blob: file, filename: file.name })),
                    'upload',
                  ),
                addRecording: (wav) =>
                  addClips(
                    [{ blob: wav, filename: t('voiceStudio.record.takeName', { index: ++takes }) }],
                    'recording',
                  ),
              }}
            />
          </>
        )}

        {voice.consent ? <ConsentRecord consent={voice.consent} /> : null}
      </div>

      <VoiceDefaults key={voice.id} voice={voice} model={model} />
    </div>
  );
}
