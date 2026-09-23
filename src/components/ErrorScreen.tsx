'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { retryStartup } from '@/lib/tauri';
import { useAppStore } from '@/store/app';

import { ErrorNotice } from './ErrorNotice';
import { Screen } from './Screen';

/** Startup failed after setup (the sidecar did not come up or stopped). */
export function ErrorScreen() {
  const { t } = useTranslation();
  const error = useAppStore((s) => s.error);
  const logsDir = useAppStore((s) => s.boot?.logs_dir ?? null);
  const [retrying, setRetrying] = useState(false);

  return (
    <Screen>
      <div className="space-y-5">
        <h1 className="text-xl font-semibold">{t('errors.title')}</h1>
        {error ? <ErrorNotice error={error} logsDir={logsDir} /> : null}
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            retryStartup().finally(() => setRetrying(false));
          }}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {t('common.actions.retry')}
        </button>
      </div>
    </Screen>
  );
}
