'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorCodeOf } from '@/lib/errors';
import { repairInstallation, retryStartup } from '@/lib/tauri';
import { useAppStore } from '@/store/app';

import { ErrorNotice } from './ErrorNotice';
import { LogViewer } from './LogViewer';
import { Screen } from './Screen';
import { button, dangerButton, primaryButton } from './ui';

/** Startup failed after setup (the sidecar did not come up, stopped, or the model did not
 * load): retry, repair the installation, or read the log. */
export function ErrorScreen() {
  const { t } = useTranslation();
  const error = useAppStore((s) => s.error);
  const logsDir = useAppStore((s) => s.boot?.logs_dir ?? null);
  const [busy, setBusy] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    action()
      .catch((err: unknown) => setActionError(errorCodeOf(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Screen wide>
      <div className="space-y-5">
        <h1 className="text-xl font-semibold">{t('errors.title')}</h1>
        {error ? <ErrorNotice error={error} logsDir={logsDir} /> : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => run(retryStartup)}
            className={primaryButton}
          >
            {t('common.actions.retry')}
          </button>
          {confirmRepair ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmRepair(true)}
              className={button}
            >
              {t('settings.repair.button')}
            </button>
          )}
        </div>
        {confirmRepair ? (
          <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/60 dark:bg-amber-950/40">
            <p>{t('settings.repair.confirm')}</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => run(repairInstallation)}
                className={dangerButton}
              >
                {t('settings.repair.start')}
              </button>
              <button type="button" onClick={() => setConfirmRepair(false)} className={button}>
                {t('settings.common.cancel')}
              </button>
            </div>
          </div>
        ) : null}
        {actionError ? <ErrorNotice error={{ code: actionError }} /> : null}
        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-500 select-none">
            {t('settings.logs.show')}
          </summary>
          <div className="pt-2">
            <LogViewer />
          </div>
        </details>
      </div>
    </Screen>
  );
}
