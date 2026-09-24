'use client';

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { WarningIcon } from '@/components/icons';
import { button, card } from '@/components/ui';
import { formatSeconds } from '@/lib/format';
import { codeOf } from '@/lib/jobs';
import type { ModelCapabilities, Voice, VoiceSource } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { EncodeBadge } from './EncodeBadge';
import { applySaved } from './jobs';

const SOURCES: VoiceSource[] = ['designed', 'imported', 'recorded', 'embedding'];

/** The voice library and the ways to add a voice (requirements §6.5 a–d, packages). */
export function VoiceList({ model }: { model: ModelCapabilities }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const api = useSidecarStore((s) => s.api);
  const voices = useVoicesStore((s) => s.voices);
  const loadError = useVoicesStore((s) => s.loadError);
  const panel = useVoicesStore((s) => s.panel);
  const encoding = useVoicesStore((s) => s.encoding);
  const packageInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const caps = model.capabilities;
  const available: Record<VoiceSource, boolean> = {
    designed: caps.caption,
    imported: caps.speaker_reference,
    recorded: caps.speaker_reference,
    embedding: caps.speaker_embedding,
  };

  const startNew = (source: VoiceSource) => {
    const store = useVoicesStore.getState();
    if (source === 'imported' || source === 'recorded') store.startClipDraft(source);
    if (source === 'designed') store.seedDesign(t('quick.sampleText'));
    store.open({ kind: 'new', source });
  };

  const importPackage = async (file: File | undefined) => {
    if (!api || !file) return;
    setImporting(true);
    setImportError(null);
    try {
      const saved = await api.importVoice(file, file.name);
      applySaved(saved);
      useVoicesStore.getState().open({ kind: 'voice', voiceId: saved.voice.id });
    } catch (err) {
      setImportError(codeOf(err));
    } finally {
      setImporting(false);
    }
  };

  const summary = (voice: Voice) => {
    if (voice.embedding) {
      return t('voiceStudio.list.embedding', { tokens: voice.embedding.tokens });
    }
    if (voice.clips.length === 0) return t('voiceStudio.list.captionOnly');
    return t('voiceStudio.list.clips', {
      count: voice.clips.length,
      seconds: formatSeconds(voice.total_seconds, locale),
    });
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">{t('voiceStudio.title')}</h1>

      <div className={`${card} space-y-2`}>
        <p className="text-sm font-medium">{t('voiceStudio.list.new')}</p>
        <div className="grid gap-1.5">
          {SOURCES.map((source) => (
            <button
              key={source}
              type="button"
              disabled={!available[source]}
              aria-pressed={panel.kind === 'new' && panel.source === source}
              onClick={() => startNew(source)}
              className={`rounded-md border px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                panel.kind === 'new' && panel.source === source
                  ? 'border-sky-600 bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-100'
                  : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800'
              }`}
            >
              <span className="block font-medium">{t(`voiceStudio.new.buttons.${source}`)}</span>
              <span className="block text-xs text-zinc-500">
                {t(`voiceStudio.new.buttonHints.${source}`)}
              </span>
            </button>
          ))}
        </div>
        <input
          ref={packageInput}
          type="file"
          accept=".irovoice"
          hidden
          onChange={(event) => {
            void importPackage(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={importing}
          onClick={() => packageInput.current?.click()}
          className={`${button} w-full`}
        >
          {importing ? t('voiceStudio.package.importing') : t('voiceStudio.package.import')}
        </button>
        {importError ? <ErrorNotice error={{ code: importError }} /> : null}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t('voiceStudio.list.title', { count: voices?.length ?? 0 })}
        </p>
        {loadError ? <ErrorNotice error={{ code: loadError }} /> : null}
        {voices && voices.length === 0 ? (
          <p className="text-sm text-zinc-500">{t('voiceStudio.list.empty')}</p>
        ) : null}
        <ul className="space-y-1.5">
          {(voices ?? []).map((voice) => {
            const open = panel.kind === 'voice' && panel.voiceId === voice.id;
            const missingConsent = voice.consent_required && voice.consent === null;
            return (
              <li key={voice.id}>
                <button
                  type="button"
                  aria-current={open ? 'true' : undefined}
                  onClick={() => useVoicesStore.getState().open({ kind: 'voice', voiceId: voice.id })}
                  className={`w-full space-y-1 rounded-lg border px-3 py-2 text-left ${
                    open
                      ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/60'
                      : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{voice.name}</span>
                    <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {t(`voiceStudio.sources.${voice.source}`)}
                    </span>
                  </span>
                  <span className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                    <span className="truncate">{summary(voice)}</span>
                    <EncodeBadge voice={voice} status={encoding[voice.id]} />
                  </span>
                  {missingConsent ? (
                    <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                      <WarningIcon className="h-3.5 w-3.5" />
                      {t('voiceStudio.list.noConsent')}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
