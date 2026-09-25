'use client';

import { useTranslation } from 'react-i18next';

import { openReleasePage, skipUpdate } from '@/lib/tauri';
import { useAppStore } from '@/store/app';

import { CrossIcon } from './icons';

const action =
  'rounded-md px-2 py-0.5 text-sm font-medium text-sky-800 underline-offset-2 hover:underline dark:text-sky-200';

/** A newer release on GitHub (D15): notification only, the user downloads it. */
export function UpdateBanner() {
  const { t } = useTranslation();
  const update = useAppStore((s) => s.update);
  const dismissed = useAppStore((s) => s.updateDismissed);
  const dismiss = useAppStore((s) => s.dismissUpdate);
  const latest = update?.latest;

  if (!latest?.newer || dismissed || latest.version === update?.skipped_version) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-100"
    >
      <span className="font-medium">
        {t('shell.update.available', { version: latest.version })}
      </span>
      <button type="button" onClick={() => void openReleasePage()} className={action}>
        {t('shell.update.open')}
      </button>
      <button type="button" onClick={() => void skipUpdate(latest.version)} className={action}>
        {t('shell.update.skip')}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('shell.update.close')}
        className="ml-auto rounded p-1 hover:bg-sky-100 dark:hover:bg-sky-900"
      >
        <CrossIcon />
      </button>
    </div>
  );
}
