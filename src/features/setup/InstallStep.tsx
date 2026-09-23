'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice, type ErrorLike } from '@/components/ErrorNotice';
import { CheckIcon, CrossIcon, DotIcon, Spinner } from '@/components/icons';
import { errorCodeOf } from '@/lib/errors';
import { formatBytes, formatPercent } from '@/lib/format';
import { startSetup } from '@/lib/tauri';
import type { StepProgress, StepState, TorchVariant } from '@/lib/types';
import { useAppStore } from '@/store/app';

import { StepFooter } from './parts';

const TORCH_VARIANTS: readonly string[] = ['cu128', 'cpu', 'pypi'] satisfies TorchVariant[];

function isTorchVariant(value: string | null): value is TorchVariant {
  return value !== null && TORCH_VARIANTS.includes(value);
}

function StateIcon({ state }: { state: StepState }) {
  switch (state) {
    case 'running':
      return <Spinner className="text-sky-500" />;
    case 'done':
      return <CheckIcon className="text-emerald-600" />;
    case 'skipped':
      return <CheckIcon className="text-zinc-400" />;
    case 'failed':
      return <CrossIcon className="text-red-500" />;
    case 'pending':
      return <DotIcon className="text-zinc-300 dark:text-zinc-600" />;
  }
}

function StepRow({ step, locale }: { step: StepProgress; locale: string }) {
  const { t } = useTranslation();
  const bytes = step.total_bytes ? { done: step.done_bytes ?? 0, total: step.total_bytes } : null;
  return (
    <li className="flex gap-3">
      <StateIcon state={step.state} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className={step.state === 'pending' ? 'text-zinc-500' : ''}>
            {t(`setup.install.steps.${step.id}`)}
          </span>
          {step.id === 'torch' && isTorchVariant(step.detail) ? (
            <span className="text-xs text-zinc-500">
              {t(`setup.install.torchVariants.${step.detail}`)}
            </span>
          ) : null}
        </p>
        {step.id === 'models' && bytes && step.state !== 'skipped' ? (
          <>
            <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
              <div
                className="h-full rounded bg-sky-500 transition-[width]"
                style={{ width: `${Math.min((bytes.done / bytes.total) * 100, 100)}%` }}
              />
            </div>
            <p className="text-xs text-zinc-500 tabular-nums">
              {t('setup.install.bytes', {
                done: formatBytes(bytes.done, locale),
                total: formatBytes(bytes.total, locale),
                percent: formatPercent(bytes.done, bytes.total, locale),
              })}
            </p>
          </>
        ) : null}
      </div>
      <span className="text-xs text-zinc-500">{t(`setup.install.states.${step.state}`)}</span>
    </li>
  );
}

/** Runs first-run setup and shows its progress; also resumes an interrupted setup. */
export function InstallStep({ resume, onBack }: { resume: boolean; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const setup = useAppStore((s) => s.setup);
  const logs = useAppStore((s) => s.logs);
  const logsDir = useAppStore((s) => s.boot?.logs_dir ?? null);
  const [startError, setStartError] = useState<ErrorLike | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const start = () =>
    startSetup().catch((err: unknown) => {
      const code = errorCodeOf(err);
      // A second start while the first is still running is harmless.
      if (code !== 'setup_already_running') setStartError({ code });
    });

  useEffect(() => {
    // Relaunch after an interruption: continue where setup stopped.
    if (resume) void start();
  }, [resume]);

  useEffect(() => {
    const pre = logRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [logs]);

  const running = setup?.running ?? false;
  const failure = setup?.error ?? startError;

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t('setup.install.heading')}</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('setup.install.description')}</p>

      <ol className="space-y-3">
        {setup?.steps.map((step) => <StepRow key={step.id} step={step} locale={locale} />)}
      </ol>

      {running ? (
        <p className="text-xs text-zinc-500">{t('setup.install.keepOpen')}</p>
      ) : null}
      {setup?.completed ? (
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          <CheckIcon /> {t('setup.install.completed')}
        </p>
      ) : null}
      {failure && !running ? (
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('setup.install.failed')}</p>
          <ErrorNotice error={failure} logsDir={logsDir} />
          <button
            type="button"
            onClick={() => {
              setStartError(null);
              void start();
            }}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            {t('common.actions.retry')}
          </button>
        </div>
      ) : null}

      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-500">{t('setup.install.log')}</summary>
        <pre
          ref={logRef}
          className="mt-2 max-h-56 overflow-auto rounded bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-300"
        >
          {logs.join('\n')}
        </pre>
      </details>

      <StepFooter onBack={running || setup?.completed ? undefined : onBack} />
    </div>
  );
}
