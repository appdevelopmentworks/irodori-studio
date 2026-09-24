'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type Api, ApiError } from '@/lib/api';
import { formatSeconds } from '@/lib/format';
import { subscribeJob } from '@/lib/sse';
import type { TtsResult } from '@/lib/types';

import { ErrorNotice } from './ErrorNotice';
import { Spinner } from './icons';

type Phase =
  | { kind: 'idle' }
  | { kind: 'queued'; position: number }
  | { kind: 'preparing' }
  | { kind: 'sampling'; done: number; total: number }
  | { kind: 'done'; result: TtsResult; elapsed: number }
  | { kind: 'cancelled' }
  | { kind: 'failed'; code: string; detail?: string };

const BUSY = new Set<Phase['kind']>(['queued', 'preparing', 'sampling']);

/** Setup step 7 (requirements §6.2): generate one sentence and play it. Session 3's
 * Quick screen replaces this card. */
export function SmokeTest({ api }: { api: Api }) {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const jobRef = useRef<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const busy = BUSY.has(phase.kind);

  useEffect(() => () => stopRef.current?.(), []);

  const run = async () => {
    stopRef.current?.();
    setPhase({ kind: 'preparing' });
    const started = performance.now();
    try {
      const { job_id: jobId } = await api.generate({ text: t('home.smokeTest.sampleText') });
      jobRef.current = jobId;
      stopRef.current = subscribeJob(api.jobEventsUrl(jobId), {
        onEvent: (event) => {
          switch (event.type) {
            case 'queued':
              setPhase(
                event.data.position > 0
                  ? { kind: 'queued', position: event.data.position }
                  : { kind: 'preparing' },
              );
              break;
            case 'started':
              setPhase({ kind: 'preparing' });
              break;
            case 'progress':
              setPhase({ kind: 'sampling', done: event.data.done, total: event.data.total });
              break;
            case 'completed':
              setPhase({
                kind: 'done',
                result: event.data,
                elapsed: (performance.now() - started) / 1000,
              });
              break;
            case 'failed':
              setPhase({ kind: 'failed', code: event.data.code, detail: event.data.message });
              break;
            case 'cancelled':
              setPhase({ kind: 'cancelled' });
              break;
          }
        },
        onError: () => setPhase({ kind: 'failed', code: 'job_not_found' }),
      });
    } catch (err) {
      setPhase({ kind: 'failed', code: err instanceof ApiError ? err.code : 'internal' });
    }
  };

  const cancel = () => {
    if (jobRef.current) api.cancelJob(jobRef.current).catch(() => undefined);
  };

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-zinc-500">{t('home.smokeTest.heading')}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('home.smokeTest.body')}</p>
      </div>
      <div className="rounded-lg border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
        <p className="text-xs text-zinc-500">{t('home.smokeTest.sampleLabel')}</p>
        <p lang="ja">{t('home.smokeTest.sampleText')}</p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={run}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {t('home.smokeTest.generate')}
        </button>
        {busy ? (
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {t('home.smokeTest.cancel')}
          </button>
        ) : null}
        {busy ? (
          <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Spinner className="text-sky-500" />
            {phase.kind === 'queued'
              ? t('home.smokeTest.queued', { position: phase.position })
              : phase.kind === 'sampling'
                ? t('home.smokeTest.sampling', { done: phase.done, total: phase.total })
                : t('home.smokeTest.preparing')}
          </p>
        ) : null}
      </div>

      {phase.kind === 'done' ? (
        <div className="space-y-2">
          <audio
            controls
            autoPlay
            src={api.audioUrl(phase.result.outputs[0].audio_id)}
            className="w-full"
          />
          <p className="text-xs text-zinc-500">
            {t('home.smokeTest.result', {
              seed: String(phase.result.used_seed),
              seconds: formatSeconds(phase.result.outputs[0].duration_s, locale, 2),
              elapsed: formatSeconds(phase.elapsed, locale),
            })}
            {' · '}
            {phase.result.watermarked
              ? t('home.smokeTest.watermarked')
              : t('home.smokeTest.notWatermarked')}
          </p>
        </div>
      ) : null}
      {phase.kind === 'cancelled' ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('home.smokeTest.cancelled')}</p>
      ) : null}
      {phase.kind === 'failed' ? (
        <ErrorNotice error={{ code: phase.code, detail: phase.detail }} />
      ) : null}
    </section>
  );
}
