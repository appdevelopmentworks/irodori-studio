'use client';

import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { useParamText } from '@/features/params/text';
import type { SamplingParams } from '@/lib/types';
import { type QuickJob, useQuickStore } from '@/store/quick';

import { cancelGeneration } from './generation';
import type { RequestProblem } from './request';

const BUSY = new Set(['submitting', 'queued', 'running']);

export const isBusy = (job: QuickJob | null) => job !== null && BUSY.has(job.phase);

/** Generate / cancel, live progress, and why generation is not possible right now. */
export function GenerateBar({
  problem,
  onGenerate,
}: {
  problem: RequestProblem | null;
  onGenerate: () => void;
}) {
  const { t } = useTranslation();
  const paramText = useParamText();
  const job = useQuickStore((s) => s.job);
  const busy = isBusy(job);

  let status: string | null = null;
  if (job?.phase === 'submitting') status = t('quick.generate.submitting');
  else if (job?.phase === 'queued') {
    status =
      job.position > 0
        ? t('quick.generate.queued', { position: job.position })
        : t('quick.generate.preparing');
  } else if (job?.phase === 'running') {
    const progress = job.progress;
    if (!progress) status = t('quick.generate.preparing');
    else if (progress.done < progress.total) {
      status = t('quick.generate.sampling', { done: progress.done, total: progress.total });
    } else status = t('quick.generate.finishing');
  }

  const progress = job?.phase === 'running' && job.progress ? job.progress : null;
  const paramError =
    job?.phase === 'failed' && job.error?.code === 'invalid_params' && job.error.detail?.param
      ? t('quick.generate.paramError', {
          param: paramText.label(job.error.detail.param as keyof SamplingParams),
          reason: paramText.reason(String(job.error.detail.reason ?? '')),
        })
      : null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || problem !== null}
          onClick={onGenerate}
          className="rounded-md bg-sky-600 px-6 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {t('quick.generate.button')}
        </button>
        {busy ? (
          <button
            type="button"
            onClick={() => void cancelGeneration()}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {t('quick.generate.cancel')}
          </button>
        ) : null}
        {busy && status ? (
          <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Spinner className="text-sky-500" />
            {status}
          </p>
        ) : null}
        {!busy && problem ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t(`quick.generate.${problem}`)}
          </p>
        ) : null}
      </div>
      {progress ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          <div
            className="h-full bg-sky-500 transition-[width]"
            style={{ width: `${(100 * progress.done) / Math.max(progress.total, 1)}%` }}
          />
        </div>
      ) : null}
      {job?.phase === 'cancelled' ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('quick.generate.cancelled')}</p>
      ) : null}
      {job?.phase === 'failed' && job.error ? (
        <div className="space-y-1">
          <ErrorNotice error={{ code: job.error.code, detail: job.error.message ?? null }} />
          {paramError ? (
            <p className="text-sm text-red-700 dark:text-red-300">{paramError}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
