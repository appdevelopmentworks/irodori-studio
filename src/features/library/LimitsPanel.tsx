'use client';

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { input } from '@/components/ui';
import { formatBytes } from '@/lib/format';
import { useLibraryStore } from '@/store/library';
import { useSidecarStore } from '@/store/sidecar';

import { loadHistory, loadUsage } from './actions';

const GB = 1_000_000_000;
const MIN_GB = 0.01; // the sidecar's floor is 10 MB

/** How much history is kept (D23): the oldest entries are deleted past either limit —
 * right away when a limit is lowered. */
export function LimitsPanel() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const entriesId = useId();
  const sizeId = useId();
  const preferences = useSidecarStore((s) => s.preferences);
  const updatePreferences = useSidecarStore((s) => s.updatePreferences);
  const usage = useLibraryStore((s) => s.usage);
  const [entries, setEntries] = useState(String(preferences?.history_max_entries ?? 500));
  const [size, setSize] = useState(String((preferences?.history_max_bytes ?? 5 * GB) / GB));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!preferences) return null;

  const maxEntries = Number.parseInt(entries, 10);
  const maxGb = Number(size);
  const valid =
    Number.isInteger(maxEntries) && maxEntries >= 1 && maxEntries <= 100_000 && maxGb >= MIN_GB;
  const changed =
    valid &&
    (maxEntries !== preferences.history_max_entries ||
      Math.round(maxGb * GB) !== preferences.history_max_bytes);

  const save = async () => {
    setSaving(true);
    setDone(false);
    const code = await updatePreferences({
      history_max_entries: maxEntries,
      history_max_bytes: Math.round(maxGb * GB),
    });
    setError(code);
    setSaving(false);
    if (!code) {
      setDone(true);
      await Promise.all([loadHistory(), loadUsage()]);
    }
  };

  return (
    <details className="rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="cursor-pointer font-semibold select-none">
        {t('library.limits.title')}
        {usage ? (
          <span className="ml-2 font-normal text-zinc-500 tabular-nums">
            {t('library.limits.usage', {
              entries: usage.entries,
              size: formatBytes(usage.bytes, locale),
            })}
          </span>
        ) : null}
      </summary>
      <div className="space-y-3 pt-3">
        <p className="text-xs text-zinc-500">{t('library.limits.hint')}</p>
        <div className="flex flex-wrap items-end gap-4">
          <label htmlFor={entriesId} className="space-y-1">
            <span className="block text-xs text-zinc-500">{t('library.limits.entries')}</span>
            <input
              id={entriesId}
              type="number"
              min={1}
              max={100000}
              value={entries}
              onChange={(event) => setEntries(event.target.value)}
              className={`${input} w-32 tabular-nums`}
            />
          </label>
          <label htmlFor={sizeId} className="space-y-1">
            <span className="block text-xs text-zinc-500">{t('library.limits.size')}</span>
            <input
              id={sizeId}
              type="number"
              min={MIN_GB}
              step={0.5}
              value={size}
              onChange={(event) => setSize(event.target.value)}
              className={`${input} w-32 tabular-nums`}
            />
          </label>
          <button
            type="button"
            disabled={saving || !changed}
            onClick={() => void save()}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {t('library.limits.save')}
          </button>
          {done ? (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">
              {t('library.limits.saved')}
            </span>
          ) : null}
        </div>
        {!valid ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">{t('library.limits.invalid')}</p>
        ) : null}
        {error ? <ErrorNotice error={{ code: error }} /> : null}
      </div>
    </details>
  );
}
