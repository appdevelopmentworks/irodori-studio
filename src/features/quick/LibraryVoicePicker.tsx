'use client';

import { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { formatSeconds } from '@/lib/format';
import type { ModelCapabilities } from '@/lib/types';
import { useNavStore } from '@/store/nav';
import { useQuickStore } from '@/store/quick';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

const button =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800';

/** A voice from the library; choosing one loads its defaults into the form. */
export function LibraryVoicePicker({ model }: { model: ModelCapabilities }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const selectId = useId();
  const api = useSidecarStore((s) => s.api);
  const voices = useVoicesStore((s) => s.voices);
  const loadError = useVoicesStore((s) => s.loadError);
  const voiceId = useQuickStore((s) => s.voiceId);
  const voice = voices?.find((v) => v.id === voiceId) ?? null;

  useEffect(() => {
    if (api) void useVoicesStore.getState().load();
  }, [api]);

  // The chosen voice was deleted (in Voice Studio).
  useEffect(() => {
    if (voices && voiceId && !voices.some((v) => v.id === voiceId)) {
      useQuickStore.getState().clearVoice();
    }
  }, [voices, voiceId]);

  const choose = (id: string) => {
    const next = voices?.find((v) => v.id === id);
    if (next) useQuickStore.getState().applyVoice(next, model.params);
    else useQuickStore.getState().clearVoice();
  };

  const openStudio = () => {
    if (voice) useVoicesStore.getState().open({ kind: 'voice', voiceId: voice.id });
    useNavStore.getState().setScreen('voices');
  };

  if (loadError) return <ErrorNotice error={{ code: loadError }} />;
  if (voices && voices.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-zinc-500">{t('quick.voice.libraryEmpty')}</p>
        <button type="button" onClick={openStudio} className={button}>
          {t('quick.voice.openStudio')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="sr-only">
          {t('quick.voice.libraryLabel')}
        </label>
        <select
          id={selectId}
          value={voiceId ?? ''}
          onChange={(event) => choose(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">{t('quick.voice.libraryChoose')}</option>
          {(voices ?? []).map((v) => (
            <option key={v.id} value={v.id} disabled={v.consent_required && v.consent === null}>
              {t('quick.voice.libraryOption', {
                name: v.name,
                source: t(`voiceStudio.sources.${v.source}`),
              })}
            </option>
          ))}
        </select>
        <button type="button" onClick={openStudio} className={button}>
          {voice ? t('quick.voice.editInStudio') : t('quick.voice.openStudio')}
        </button>
      </div>
      {voice ? (
        <p className="text-xs text-zinc-500">
          {voice.embedding
            ? t('quick.voice.librarySummaryEmbedding')
            : voice.clips.length > 0
              ? t('quick.voice.librarySummaryClips', {
                  count: voice.clips.length,
                  seconds: formatSeconds(voice.total_seconds, locale),
                })
              : t('quick.voice.librarySummaryCaption')}{' '}
          {t('quick.voice.defaultsApplied')}
        </p>
      ) : (
        <p className="text-xs text-zinc-500">{t('quick.voice.libraryHint')}</p>
      )}
    </div>
  );
}
