'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type Api, createApi } from '@/lib/api';
import { formatMemory } from '@/lib/format';
import { getSidecarPort } from '@/lib/tauri';
import type { SystemInfo } from '@/lib/types';
import { useAppStore } from '@/store/app';

import { LanguageSwitcher } from './LanguageSwitcher';
import { Screen } from './Screen';
import { SmokeTest } from './SmokeTest';

// Placeholder until Session 3's app shell (docs/project-structure.md): proves the sidecar
// and the model are up, with a one-sentence test generation (setup step 7).
export function ReadyScreen() {
  const { t, i18n } = useTranslation();
  const setPort = useAppStore((s) => s.setPort);
  const [api, setApi] = useState<Api | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getSidecarPort()
      .then((port) => {
        setPort(port);
        const client = createApi(port);
        if (active) setApi(client);
        return client.getSystem();
      })
      .then((info) => active && setSystem(info))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [setPort]);

  const locale = i18n.resolvedLanguage ?? i18n.language;
  const device = system?.device;
  const rows: [string, string][] = system
    ? [
        [
          t('home.system.device'),
          [t(`setup.environment.modes.${system.device.kind}`), device?.name]
            .filter(Boolean)
            .join(' — '),
        ],
        ...(device?.memory_total_mb != null
          ? [
              [
                t('home.system.memory'),
                t('home.system.memoryUsage', {
                  used: formatMemory((device.memory_used_mb ?? 0) * 1024 * 1024, locale),
                  total: formatMemory(device.memory_total_mb * 1024 * 1024, locale),
                }),
              ] as [string, string],
            ]
          : []),
        [t('home.system.torch'), system.torch?.version ?? '—'],
        ...(system.torch?.cuda_version
          ? [[t('home.system.cuda'), system.torch.cuda_version] as [string, string]]
          : []),
        [t('home.system.python'), system.python_version],
        [t('home.system.upstream'), system.upstream_commit?.slice(0, 7) ?? '—'],
      ]
    : [];

  return (
    <Screen>
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('home.ready.heading')}</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('home.ready.body')}</p>
        </header>

        <section className="space-y-2">
          <h2 className="text-sm font-medium text-zinc-500">{t('home.system.heading')}</h2>
          {system ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-zinc-500">{label}</dt>
                  <dd className="font-mono break-all">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-zinc-500">
              {failed ? t('home.system.failed') : t('home.system.loading')}
            </p>
          )}
          {system?.device.kind === 'cpu' ? (
            // D7: CPU mode is never silent.
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('setup.environment.notices.cpu_mode_slow')}
            </p>
          ) : null}
          {system?.issues.map((issue) => (
            <p key={issue} className="text-sm text-amber-700 dark:text-amber-300">
              {t(`errors.codes.${issue}`)}
            </p>
          ))}
        </section>

        {api ? <SmokeTest api={api} /> : null}

        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t('common.japaneseOnlyNotice')}
        </p>

        <LanguageSwitcher />
      </div>
    </Screen>
  );
}
