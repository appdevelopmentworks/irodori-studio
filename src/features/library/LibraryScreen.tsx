'use client';

import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { type LibraryTab, useLibraryStore } from '@/store/library';
import { useSidecarStore } from '@/store/sidecar';

import { HistoryPanel } from './HistoryPanel';
import { PresetsPanel } from './PresetsPanel';

const TABS: LibraryTab[] = ['history', 'presets'];

/** ライブラリ・履歴: every generation with its settings, and the parameter presets
 * (requirements §6.8). */
export function LibraryScreen() {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const model = useSidecarStore((s) => s.capabilities);
  const loadError = useSidecarStore((s) => s.loadError);
  const tab = useLibraryStore((s) => s.tab);

  if (loadError) {
    return (
      <div className="p-6">
        <ErrorNotice error={{ code: loadError }} />
      </div>
    );
  }
  if (!model || !api) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('library.title')}</h1>
        <div role="tablist" aria-label={t('library.title')} className="flex gap-1">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => useLibraryStore.getState().setTab(id)}
              className={`rounded-md px-3 py-1.5 text-sm ${
                tab === id
                  ? 'bg-sky-50 font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
              }`}
            >
              {t(`library.tabs.${id}`)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'history' ? <HistoryPanel model={model} /> : <PresetsPanel model={model} />}
    </div>
  );
}
