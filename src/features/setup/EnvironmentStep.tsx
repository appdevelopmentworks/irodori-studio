'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice, type ErrorLike } from '@/components/ErrorNotice';
import { Spinner, WarningIcon } from '@/components/icons';
import { errorCodeOf } from '@/lib/errors';
import { formatMemory } from '@/lib/format';
import { probePlatform, setDeviceChoice } from '@/lib/tauri';
import type { DeviceChoice, ProbeReport } from '@/lib/types';
import { useAppStore } from '@/store/app';

import { StepFooter } from './parts';

/** Probe result and inference mode (D7–D9), with an explicit CPU-mode choice. */
export function EnvironmentStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const choice = useAppStore((s) => s.boot?.device_choice ?? 'auto');
  const patchBoot = useAppStore((s) => s.patchBoot);
  const [probe, setProbe] = useState<ProbeReport | null>(null);
  const [error, setError] = useState<ErrorLike | null>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    let active = true;
    probePlatform()
      .then((report) => active && setProbe(report))
      .catch((err: unknown) => active && setError({ code: errorCodeOf(err) }));
    return () => {
      active = false;
    };
  }, []);

  const changeChoice = (next: DeviceChoice) => {
    setDeviceChoice(next)
      .then(() => patchBoot({ device_choice: next }))
      .catch((err: unknown) => setError({ code: errorCodeOf(err) }));
  };

  if (!probe) {
    return (
      <div className="space-y-5">
        <h2 className="text-lg font-semibold">{t('setup.environment.heading')}</h2>
        {error ? (
          <ErrorNotice error={error} />
        ) : (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> {t('setup.environment.detecting')}
          </p>
        )}
        <StepFooter onBack={onBack} />
      </div>
    );
  }

  const plan = choice === 'cpu' ? probe.cpu : probe.recommended;
  const gpuUsable = probe.recommended.device !== 'cpu';

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t('setup.environment.heading')}</h2>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {probe.os === 'macos' && probe.apple ? (
          <>
            <dt className="text-zinc-500">{t('setup.environment.chip')}</dt>
            <dd>
              {t('setup.environment.chipSpec', {
                chip: probe.apple.chip,
                memory: formatMemory(probe.apple.memory_bytes, locale),
                version: probe.apple.macos_version,
              })}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-zinc-500">{t('setup.environment.gpu')}</dt>
            <dd className="space-y-1">
              {probe.nvidia.length > 0
                ? probe.nvidia.map((gpu) => (
                    <p key={gpu.index}>
                      {t('setup.environment.gpuSpec', {
                        name: gpu.name,
                        vram: formatMemory(gpu.vram_mib * 1024 * 1024, locale),
                        driver: gpu.driver_version,
                      })}
                    </p>
                  ))
                : t('setup.environment.noGpu')}
            </dd>
          </>
        )}
        <dt className="text-zinc-500">{t('setup.environment.mode')}</dt>
        <dd>
          <span className="font-semibold">{t(`setup.environment.modes.${plan.device}`)}</span>{' '}
          <span className="text-zinc-500">
            {t('setup.environment.precision', { precision: plan.precision.toUpperCase() })}
          </span>
        </dd>
      </dl>

      {probe.blocker ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
          {t(`setup.environment.blockers.${probe.blocker}`)}
        </div>
      ) : null}

      {plan.notices.length > 0 ? (
        <ul className="space-y-2">
          {plan.notices.map((notice) => (
            <li
              key={notice}
              className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <WarningIcon className="mt-0.5 h-4 w-4 text-amber-500" />
              {t(`setup.environment.notices.${notice}`)}
            </li>
          ))}
        </ul>
      ) : null}

      {gpuUsable && !probe.blocker ? (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={choice === 'cpu'}
            onChange={(event) => changeChoice(event.target.checked ? 'cpu' : 'auto')}
            className="h-4 w-4 accent-sky-600"
          />
          {t('setup.environment.useCpu')}
        </label>
      ) : null}

      {error ? <ErrorNotice error={error} /> : null}
      <StepFooter onBack={onBack} onNext={onNext} nextDisabled={probe.blocker !== null} />
    </div>
  );
}
