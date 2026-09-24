'use client';

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { CrossIcon } from '@/components/icons';
import type { ReferenceKind } from '@/features/params/schema';
import { ApiError } from '@/lib/api';
import { formatSeconds } from '@/lib/format';
import type { ModelCapabilities } from '@/lib/types';
import { useQuickStore } from '@/store/quick';
import { useSidecarStore } from '@/store/sidecar';

import { LibraryVoicePicker } from './LibraryVoicePicker';
import { useEmbeddingPicker } from './useEmbeddingPicker';

const button =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800';

let uploadCounter = 0;

/** Who speaks: nobody in particular, reference clips (uploaded, ordered), a speaker
 * embedding file, or a library voice (with its defaults). */
export function VoiceSection({ model }: { model: ModelCapabilities }) {
  const { capabilities, limits } = model;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const fileInput = useRef<HTMLInputElement>(null);
  const api = useSidecarStore((s) => s.api);
  const reference = useQuickStore((s) => s.reference);
  const setReference = useQuickStore((s) => s.setReference);
  const clips = useQuickStore((s) => s.clips);
  const uploads = useQuickStore((s) => s.uploads);
  const embeddingPath = useQuickStore((s) => s.embeddingPath);
  const pickEmbedding = useEmbeddingPicker();
  const store = useQuickStore.getState;

  const kinds: { kind: ReferenceKind; enabled: boolean }[] = [
    { kind: 'none', enabled: true },
    { kind: 'clips', enabled: capabilities.speaker_reference },
    { kind: 'embedding', enabled: capabilities.speaker_embedding },
    { kind: 'voice', enabled: true },
  ];

  const upload = async (files: FileList | null) => {
    if (!api || !files) return;
    for (const file of Array.from(files)) {
      const key = `upload-${++uploadCounter}`;
      store().addUpload({ key, filename: file.name, error: null });
      try {
        store().finishUpload(key, await api.uploadClip(file, file.name));
      } catch (err) {
        store().failUpload(key, err instanceof ApiError ? err.code : 'internal');
      }
    }
  };

  const chooseEmbedding = async () => {
    const path = await pickEmbedding();
    if (path) store().setEmbeddingPath(path);
  };

  const total = clips.reduce((sum, clip) => sum + clip.duration_s, 0);

  return (
    <section className="space-y-3">
      <p className="text-sm font-medium">{t('quick.voice.label')}</p>
      <div role="radiogroup" aria-label={t('quick.voice.label')} className="flex flex-wrap gap-1.5">
        {kinds.map(({ kind, enabled }) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={reference === kind}
            disabled={!enabled}
            onClick={() => setReference(kind)}
            className={`rounded-full border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
              reference === kind
                ? 'border-sky-600 bg-sky-600 text-white'
                : 'border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
            }`}
          >
            {t(`quick.voice.kinds.${kind === 'voice' ? 'library' : kind}`)}
          </button>
        ))}
      </div>

      {reference === 'none' ? (
        <p className="text-xs text-zinc-500">{t('quick.voice.noneHint')}</p>
      ) : null}

      {reference === 'voice' ? <LibraryVoicePicker model={model} /> : null}

      {reference === 'clips' ? (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">
            {t('quick.voice.clipsHint', { max: formatSeconds(capabilities.max_ref_seconds, locale, 0) })}
          </p>
          {clips.length > 0 ? (
            <ol className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white text-sm dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {clips.map((clip, index) => (
                <li key={clip.clip_id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="w-5 text-right text-xs text-zinc-400 tabular-nums">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{clip.filename}</span>
                  <span className="text-xs text-zinc-500 tabular-nums">
                    {t('quick.voice.clipDuration', { seconds: formatSeconds(clip.duration_s, locale) })}
                  </span>
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => store().moveClip(clip.clip_id, -1)}
                    aria-label={t('quick.voice.moveUp')}
                    title={t('quick.voice.moveUp')}
                    className="rounded px-1.5 text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === clips.length - 1}
                    onClick={() => store().moveClip(clip.clip_id, 1)}
                    aria-label={t('quick.voice.moveDown')}
                    title={t('quick.voice.moveDown')}
                    className="rounded px-1.5 text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => store().removeClip(clip.clip_id)}
                    aria-label={t('quick.voice.remove')}
                    title={t('quick.voice.remove')}
                    className="rounded px-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    <CrossIcon />
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {uploads.map((item) =>
            item.error ? (
              <div key={item.key} className="space-y-1">
                <p className="text-xs text-zinc-500">{item.filename}</p>
                <ErrorNotice error={{ code: item.error }} />
                <button type="button" onClick={() => store().dismissUpload(item.key)} className={button}>
                  {t('quick.voice.remove')}
                </button>
              </div>
            ) : (
              <p key={item.key} className="text-xs text-zinc-500">
                {item.filename} — {t('quick.voice.uploading')}
              </p>
            ),
          )}
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept="audio/*,.wav,.flac,.ogg,.opus,.mp3,.m4a,.webm"
              multiple
              hidden
              onChange={(event) => {
                void upload(event.target.files);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={clips.length + uploads.length >= limits.max_clips}
              onClick={() => fileInput.current?.click()}
              className={button}
            >
              {t('quick.voice.addClips')}
            </button>
            {clips.length > 0 ? (
              <span className="text-xs text-zinc-500 tabular-nums">
                {t('quick.voice.clipsTotal', { seconds: formatSeconds(total, locale) })}
              </span>
            ) : null}
          </div>
          {total > capabilities.max_ref_seconds ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('quick.voice.clipsOver', { max: formatSeconds(capabilities.max_ref_seconds, locale, 0) })}
            </p>
          ) : null}
        </div>
      ) : null}

      {reference === 'embedding' ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate rounded-md border border-zinc-300 px-2 py-1.5 font-mono text-xs dark:border-zinc-700">
              {embeddingPath ?? t('quick.voice.embeddingNone')}
            </p>
            <button type="button" onClick={chooseEmbedding} className={button}>
              {t('quick.voice.chooseEmbedding')}
            </button>
            {embeddingPath ? (
              <button type="button" onClick={() => store().setEmbeddingPath(null)} className={button}>
                {t('quick.voice.clear')}
              </button>
            ) : null}
          </div>
          <p className="text-xs text-zinc-500">{t('quick.voice.embeddingHint')}</p>
        </div>
      ) : null}
    </section>
  );
}
