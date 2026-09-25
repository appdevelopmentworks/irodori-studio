'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { button } from '@/components/ui';
import { errorCodeOf } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { checkForUpdates, openReleasePage, setUpdateCheck } from '@/lib/tauri';
import type { ApiServerStatus } from '@/lib/types';
import { useAppStore } from '@/store/app';
import { useNavStore } from '@/store/nav';
import { useSettingsStore } from '@/store/settings';
import { useSidecarStore } from '@/store/sidecar';

import { Section } from './Section';

export function GeneralTab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <Section title={t('settings.general.language')}>
        <LanguageSwitcher />
      </Section>
      <UpdatesSection />
      <ApiServerSection />
      <ShortcutsSection />
    </div>
  );
}

/** The GitHub Releases check (D15): notification only. */
function UpdatesSection() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const info = useSettingsStore((s) => s.info);
  const update = useAppStore((s) => s.update);
  const [error, setError] = useState<string | null>(null);

  if (!info) return null;
  const latest = update?.latest ?? null;
  const checkedAt = update?.checked_at ? new Date(update.checked_at * 1000).toISOString() : null;

  return (
    <Section title={t('settings.updates.title')} description={t('settings.updates.hint')}>
      <p className="text-sm">{t('settings.updates.current', { version: info.app_version })}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={info.update_check}
          onChange={(event) => {
            const enabled = event.target.checked;
            setUpdateCheck(enabled)
              .then(() => useSettingsStore.getState().patch({ update_check: enabled }))
              .catch((err: unknown) => setError(errorCodeOf(err)));
          }}
          className="h-4 w-4"
        />
        {t('settings.updates.auto')}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={update?.checking}
          onClick={() => {
            setError(null);
            checkForUpdates()
              .then(useAppStore.getState().setUpdate)
              .catch((err: unknown) => setError(errorCodeOf(err)));
          }}
          className={button}
        >
          {t('settings.updates.checkNow')}
        </button>
        <span className="text-sm" aria-live="polite">
          {update?.checking
            ? t('settings.updates.checking')
            : latest?.newer
              ? t('settings.updates.available', { version: latest.version })
              : latest || (checkedAt && !update?.error)
                ? t('settings.updates.upToDate')
                : null}
        </span>
        {latest?.newer && !update?.checking ? (
          <button type="button" onClick={() => void openReleasePage()} className={button}>
            {t('settings.updates.open')}
          </button>
        ) : null}
      </div>
      {checkedAt ? (
        <p className="text-xs text-zinc-500">
          {t('settings.updates.checkedAt', {
            time: formatDateTime(checkedAt, locale),
          })}
        </p>
      ) : null}
      {update?.error && !update.checking ? <ErrorNotice error={{ code: update.error }} /> : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </Section>
  );
}

/** A shortcut to the API Server screen with its state. */
function ApiServerSection() {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const [status, setStatus] = useState<ApiServerStatus | null>(null);

  useEffect(() => {
    if (!api) return;
    api
      .getApiServerStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, [api]);

  return (
    <Section title={t('settings.apiServer.title')} description={t('settings.apiServer.hint')}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          {status?.running
            ? t('settings.apiServer.running', { url: status.urls[0] ?? '' })
            : t('settings.apiServer.stopped')}
        </span>
        <button
          type="button"
          onClick={() => useNavStore.getState().setScreen('apiServer')}
          className={button}
        >
          {t('settings.apiServer.open')}
        </button>
      </div>
    </Section>
  );
}

function ShortcutsSection() {
  const { t } = useTranslation();
  const macos = useSidecarStore((s) => s.system?.platform === 'macos');
  const mod = macos ? t('settings.shortcuts.cmd') : t('settings.shortcuts.ctrl');
  const rows: [string, string][] = [
    [`${mod} + 1–7`, t('settings.shortcuts.screens')],
    [`${mod} + ,`, t('settings.shortcuts.settings')],
    [`${mod} + ${t('settings.shortcuts.enter')}`, t('settings.shortcuts.generate')],
  ];
  return (
    <Section title={t('settings.shortcuts.title')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([keys, action]) => (
          <div key={keys} className="contents">
            <dt>
              <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-800">
                {keys}
              </kbd>
            </dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
