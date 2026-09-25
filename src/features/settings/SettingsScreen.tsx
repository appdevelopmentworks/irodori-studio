'use client';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { SETTINGS_TABS, useSettingsStore } from '@/store/settings';

import { AboutTab } from './AboutTab';
import { EngineTab } from './EngineTab';
import { GeneralTab } from './GeneralTab';
import { LogsTab } from './LogsTab';
import { OutputTab } from './OutputTab';
import { StorageTab } from './StorageTab';

/** 設定 (requirements §6.11): language and updates, the data root, model and device,
 * generation and output defaults, logs, licenses and terms. */
export function SettingsScreen() {
  const { t } = useTranslation();
  const tab = useSettingsStore((s) => s.tab);

  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('settings.title')}</h1>
        <div role="tablist" aria-label={t('settings.title')} className="flex flex-wrap gap-1">
          {SETTINGS_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => useSettingsStore.getState().setTab(id)}
              className={`rounded-md px-3 py-1.5 text-sm ${
                tab === id
                  ? 'bg-sky-50 font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
            >
              {t(`settings.tabs.${id}`)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'general' ? (
        <GeneralTab />
      ) : tab === 'storage' ? (
        <StorageTab />
      ) : tab === 'engine' ? (
        <EngineTab />
      ) : tab === 'output' ? (
        <OutputTab />
      ) : tab === 'logs' ? (
        <LogsTab />
      ) : (
        <AboutTab />
      )}
    </div>
  );
}
