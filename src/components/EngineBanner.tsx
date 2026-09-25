'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorCodeOf } from '@/lib/errors';
import { restartSidecar } from '@/lib/tauri';
import { useSidecarStore } from '@/store/sidecar';

import { WarningIcon } from './icons';

/** The engine stopped working after it had loaded (e.g. the GPU failed mid-generation,
 * `device_lost`): say so and offer a restart, which loads the model afresh. */
export function EngineBanner() {
  const { t } = useTranslation();
  const engine = useSidecarStore((s) => s.engine);
  const [restarting, setRestarting] = useState(false);

  if (engine?.state !== 'error') return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/50 dark:text-red-100"
    >
      <WarningIcon className="text-red-500" />
      <span>{t(`errors.codes.${errorCodeOf(engine.error_code ?? 'model_load_failed')}`)}</span>
      <button
        type="button"
        disabled={restarting}
        onClick={() => {
          setRestarting(true);
          restartSidecar().catch(() => setRestarting(false));
        }}
        className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        {t('shell.engine.restart')}
      </button>
    </div>
  );
}
