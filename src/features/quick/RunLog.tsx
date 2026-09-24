'use client';

import { useTranslation } from 'react-i18next';

import { formatSeconds } from '@/lib/format';
import type { ParamSchema } from '@/lib/types';
import { useQuickStore } from '@/store/quick';

/** Run log (Space parity): used seed, watermark, timing breakdown and log lines. */
export function RunLog({ seedParam }: { seedParam: ParamSchema | undefined }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const job = useQuickStore((s) => s.job);
  const setParam = useQuickStore((s) => s.setParam);
  if (!job) return null;

  const result = job.result;
  // Unknown stage names (a newer upstream) show as they are.
  const stage = (name: string) =>
    i18n.exists(`quick.runLog.stages.${name}`) ? t(`quick.runLog.stages.${name}` as never) : name;
  const ms = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const elapsed =
    job.finishedAt !== null ? formatSeconds((job.finishedAt - job.startedAt) / 1000, locale) : null;

  return (
    <details
      open
      className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
    >
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium select-none">
        {t('quick.runLog.title')}
      </summary>
      <div className="space-y-4 px-4 pt-1 pb-4 text-sm">
        {result ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <dl className="flex items-center gap-2">
              <dt className="text-zinc-500">{t('quick.runLog.seed')}</dt>
              <dd className="font-mono select-all">{result.used_seed}</dd>
            </dl>
            {seedParam ? (
              <button
                type="button"
                onClick={() => setParam('seed', result.used_seed, seedParam.default)}
                className="rounded-md border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {t('quick.runLog.useSeed')}
              </button>
            ) : null}
            <span className="text-zinc-600 dark:text-zinc-400">
              {result.watermarked ? t('quick.runLog.watermarked') : t('quick.runLog.notWatermarked')}
            </span>
            {elapsed ? (
              <span className="text-zinc-600 dark:text-zinc-400">
                {t('quick.runLog.elapsed', { seconds: elapsed })}
              </span>
            ) : null}
          </div>
        ) : null}
        {result ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-zinc-500">{t('quick.runLog.timings')}</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-0.5 text-xs">
              {Object.entries(result.timings).map(([name, value]) => (
                <div key={name} className="contents">
                  <dt title={name}>{stage(name)}</dt>
                  <dd className="text-right tabular-nums">
                    {t('quick.runLog.ms', { ms: ms.format(value) })}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        <div className="space-y-1">
          <p className="text-xs font-medium text-zinc-500">{t('quick.runLog.log')}</p>
          <pre className="max-h-48 overflow-auto rounded-md bg-zinc-50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap dark:bg-black/40">
            {job.logs.length > 0 ? job.logs.join('\n') : t('quick.runLog.empty')}
          </pre>
        </div>
      </div>
    </details>
  );
}
