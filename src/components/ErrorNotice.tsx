'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorCodeOf } from '@/lib/errors';

import { WarningIcon } from './icons';

export interface ErrorLike {
  code: string;
  detail?: string | null;
}

/** Translated message for an error code, with the technical detail on demand. */
export function ErrorNotice({ error, logsDir }: { error: ErrorLike; logsDir?: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const code = errorCodeOf(error);

  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200"
    >
      <div className="flex gap-2">
        <WarningIcon className="mt-0.5 text-red-500" />
        <p>{t(`errors.codes.${code}`)}</p>
      </div>
      {logsDir ? <p className="text-xs opacity-80">{t('errors.logsAt', { path: logsDir })}</p> : null}
      {error.detail ? (
        <div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs font-medium underline underline-offset-2"
          >
            {open ? t('common.actions.hideDetails') : t('common.actions.showDetails')}
          </button>
          {open ? (
            <pre className="mt-2 max-h-48 overflow-auto rounded bg-white/70 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-red-950 dark:bg-black/40 dark:text-red-100">
              {error.detail}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
