'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { CrossIcon, Spinner } from '@/components/icons';
import { ApiError } from '@/lib/api';
import { codeOf } from '@/lib/jobs';
import type { DictionaryEntry, DictionaryEntryInput } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';

const input =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const button =
  'rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800';

interface Row extends DictionaryEntryInput {
  key: string;
}

let counter = 0;
const toRow = (entry: DictionaryEntryInput): Row => ({ ...entry, key: `row-${++counter}` });
const same = (rows: Row[], saved: DictionaryEntry[]) =>
  rows.length === saved.length &&
  rows.every(
    (row, i) =>
      row.surface === saved[i].surface &&
      row.reading === saved[i].reading &&
      row.enabled === saved[i].enabled &&
      (row.note ?? '') === (saved[i].note ?? ''),
  );

/** The user dictionary (D19): words and the readings the model is given instead, applied
 * before generation (Quick screen, narration, and later the compatible APIs). */
export function DictionaryEditor({ onSaved }: { onSaved?: () => void }) {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const [saved, setSaved] = useState<DictionaryEntry[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; index: number | null } | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  useEffect(() => {
    if (!api) return;
    let active = true;
    api
      .getDictionary()
      .then((entries) => {
        if (!active) return;
        setSaved(entries);
        setRows(entries.map(toRow));
      })
      .catch((err: unknown) => {
        if (active) setError({ code: codeOf(err), index: null });
      });
    return () => {
      active = false;
    };
  }, [api]);

  if (!api) return null;
  if (saved === null && !error) {
    return <Spinner className="h-5 w-5 text-zinc-400" />;
  }

  const update = (key: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const entries = await api.putDictionary(
        rows
          .filter((row) => row.surface.trim() || row.reading.trim())
          .map(({ surface, reading, enabled, note }) => ({
            surface: surface.trim(),
            reading: reading.trim(),
            enabled,
            note: note?.trim() || null,
          })),
      );
      setSaved(entries);
      setRows(entries.map(toRow));
      setSavedOnce(true);
      onSaved?.();
    } catch (err) {
      const index =
        err instanceof ApiError && typeof err.detail.index === 'number' ? err.detail.index : null;
      setError({ code: codeOf(err), index });
    } finally {
      setBusy(false);
    }
  };

  const dirty = saved !== null && !same(rows, saved);

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">{t('dictionary.hint')}</p>
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="pb-1 font-normal">{t('dictionary.surface')}</th>
                <th className="pb-1 font-normal">{t('dictionary.reading')}</th>
                <th className="pb-1 font-normal">{t('dictionary.note')}</th>
                <th className="pb-1 text-center font-normal">{t('dictionary.enabled')}</th>
                <th className="pb-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={row.key}
                  className={error?.index === index ? 'bg-red-50 dark:bg-red-950/40' : undefined}
                >
                  <td className="py-0.5 pr-2">
                    <input
                      lang="ja"
                      value={row.surface}
                      maxLength={64}
                      aria-label={t('dictionary.surface')}
                      placeholder={t('dictionary.surfacePlaceholder')}
                      onChange={(event) => update(row.key, { surface: event.target.value })}
                      className={input}
                    />
                  </td>
                  <td className="py-0.5 pr-2">
                    <input
                      lang="ja"
                      value={row.reading}
                      maxLength={128}
                      aria-label={t('dictionary.reading')}
                      placeholder={t('dictionary.readingPlaceholder')}
                      onChange={(event) => update(row.key, { reading: event.target.value })}
                      className={input}
                    />
                  </td>
                  <td className="py-0.5 pr-2">
                    <input
                      value={row.note ?? ''}
                      maxLength={200}
                      aria-label={t('dictionary.note')}
                      onChange={(event) => update(row.key, { note: event.target.value })}
                      className={input}
                    />
                  </td>
                  <td className="py-0.5 text-center">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      aria-label={t('dictionary.enabled')}
                      onChange={(event) => update(row.key, { enabled: event.target.checked })}
                    />
                  </td>
                  <td className="py-0.5 pl-1">
                    <button
                      type="button"
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                      aria-label={t('dictionary.remove')}
                      title={t('dictionary.remove')}
                      className="rounded px-1.5 py-0.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    >
                      <CrossIcon className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">{t('dictionary.empty')}</p>
      )}
      {error ? (
        <div className="space-y-1">
          <ErrorNotice error={{ code: error.code }} />
          {error.index !== null ? (
            <p className="text-xs text-red-700 dark:text-red-300">
              {t('dictionary.badRow', { row: error.index + 1 })}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setRows((current) => [
              ...current,
              toRow({ surface: '', reading: '', enabled: true, note: null }),
            ])
          }
          className={button}
        >
          {t('dictionary.add')}
        </button>
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void save()}
          className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {t('dictionary.save')}
        </button>
        {dirty ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => saved && setRows(saved.map(toRow))}
            className={button}
          >
            {t('dictionary.revert')}
          </button>
        ) : null}
        {dirty ? (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {t('dictionary.unsaved')}
          </span>
        ) : savedOnce ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-400">
            {t('dictionary.saved')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
