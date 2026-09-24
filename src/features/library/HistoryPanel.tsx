'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { button, card, dangerButton, input, primaryButton } from '@/components/ui';
import { usePlayer } from '@/components/usePlayer';
import { OutputSettings } from '@/features/output/OutputSettings';
import { codeOf } from '@/lib/jobs';
import { pickDirectory } from '@/lib/tauri';
import type { ExportedFile, ModelCapabilities } from '@/lib/types';
import { EMPTY_FILTERS, useLibraryStore } from '@/store/library';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { exportEntries, loadHistory, loadUsage, remove } from './actions';
import { HistoryRow } from './HistoryRow';
import { LimitsPanel } from './LimitsPanel';

const SEARCH_DELAY_MS = 300;
const DEFAULT_TEMPLATE = '{date}_{text_head}';
const TOKENS = ['date', 'n', 'index', 'text_head', 'seed', 'id'] as const;

/** Every generation (D23): search and filter, play and adopt candidates, generate again,
 * reuse settings on the Quick screen, save, export several at once, delete; limits. */
export function HistoryPanel({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const ids = { q: useId(), voice: useId(), from: useId(), to: useId(), template: useId() };
  const templateField = useRef<HTMLInputElement>(null);
  const api = useSidecarStore((s) => s.api);
  const voices = useVoicesStore((s) => s.voices);
  const filters = useLibraryStore((s) => s.filters);
  const items = useLibraryStore((s) => s.items);
  const total = useLibraryStore((s) => s.total);
  const selected = useLibraryStore((s) => s.selected);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [files, setFiles] = useState<ExportedFile[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const player = usePlayer(api ? api.audioUrl : null);

  useEffect(() => {
    if (!api) return;
    void useVoicesStore.getState().load();
    void loadUsage();
  }, [api]);

  // Reload when the filters change (typing in the search waits a moment).
  useEffect(() => {
    if (!api) return;
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true);
      void loadHistory().then((code) => {
        if (!active) return;
        setError(code);
        setLoading(false);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, filters]);

  if (!api) return null;

  const setFilters = useLibraryStore.getState().setFilters;
  const filtered = filters !== EMPTY_FILTERS && Object.values(filters).some(Boolean);
  const allSelected = items !== null && items.length > 0 && selected.length === items.length;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const exportSelected = () =>
    run(async () => {
      const folder = await pickDirectory(t('library.export.folderTitle'));
      if (!folder) return;
      const result = await exportEntries(selected, folder, template);
      setFiles(result.files);
    });

  const insertToken = (token: string) => {
    const field = templateField.current;
    const start = field?.selectionStart ?? template.length;
    const end = field?.selectionEnd ?? template.length;
    const inserted = `{${token}}`;
    setTemplate(template.slice(0, start) + inserted + template.slice(end));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  };

  return (
    <section className="space-y-4">
      {player.element}
      <div className={`${card} flex flex-wrap items-end gap-3`}>
        <label htmlFor={ids.q} className="min-w-48 flex-1 space-y-1 text-sm">
          <span className="block text-xs text-zinc-500">{t('library.filters.search')}</span>
          <input
            id={ids.q}
            type="search"
            lang="ja"
            value={filters.q}
            placeholder={t('library.filters.searchPlaceholder')}
            onChange={(event) => setFilters({ q: event.target.value })}
            className={input}
          />
        </label>
        <label htmlFor={ids.voice} className="space-y-1 text-sm">
          <span className="block text-xs text-zinc-500">{t('library.filters.voice')}</span>
          <select
            id={ids.voice}
            value={filters.voice}
            onChange={(event) => setFilters({ voice: event.target.value })}
            className={`${input} max-w-56`}
          >
            <option value="">{t('library.filters.voiceAll')}</option>
            <option value="none">{t('library.filters.voiceNone')}</option>
            {(voices ?? []).map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.from} className="space-y-1 text-sm">
          <span className="block text-xs text-zinc-500">{t('library.filters.from')}</span>
          <input
            id={ids.from}
            type="date"
            value={filters.from}
            onChange={(event) => setFilters({ from: event.target.value })}
            className={input}
          />
        </label>
        <label htmlFor={ids.to} className="space-y-1 text-sm">
          <span className="block text-xs text-zinc-500">{t('library.filters.to')}</span>
          <input
            id={ids.to}
            type="date"
            value={filters.to}
            onChange={(event) => setFilters({ to: event.target.value })}
            className={input}
          />
        </label>
        {filtered ? (
          <button
            type="button"
            onClick={() => useLibraryStore.getState().setFilters(EMPTY_FILTERS)}
            className={button}
          >
            {t('library.filters.clear')}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={!items || items.length === 0}
            onChange={() =>
              useLibraryStore
                .getState()
                .setSelected(allSelected ? [] : (items ?? []).map((item) => item.id))
            }
          />
          {t('library.history.selectAll')}
        </label>
        <span className="text-zinc-500 tabular-nums">
          {selected.length > 0
            ? t('library.history.selected', { count: selected.length, total })
            : t('library.history.total', { count: total })}
        </span>
        {loading ? <Spinner className="h-4 w-4 text-sky-500" /> : null}
        {selected.length > 0 ? (
          <span className="ml-auto flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setExporting(true);
                setFiles(null);
              }}
              className={button}
            >
              {t('library.export.open')}
            </button>
            {deleting ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const code = await remove(selected);
                      setDeleting(false);
                      if (code) setError(code);
                    })
                  }
                  className={dangerButton}
                >
                  {t('library.history.deleteSelected', { count: selected.length })}
                </button>
                <button type="button" onClick={() => setDeleting(false)} className={button}>
                  {t('library.common.cancel')}
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setDeleting(true)} className={button}>
                {t('library.history.delete')}
              </button>
            )}
          </span>
        ) : null}
      </div>

      {exporting && selected.length > 0 ? (
        <div className={`${card} space-y-3`}>
          <h3 className="text-sm font-semibold">
            {t('library.export.title', { count: selected.length })}
          </h3>
          <p className="text-xs text-zinc-500">{t('library.export.hint')}</p>
          <label htmlFor={ids.template} className="block space-y-1 text-sm">
            <span className="block text-xs text-zinc-500">{t('library.export.template')}</span>
            <input
              id={ids.template}
              ref={templateField}
              value={template}
              maxLength={200}
              spellCheck={false}
              onChange={(event) => setTemplate(event.target.value)}
              className={`${input} font-mono`}
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {TOKENS.map((token) => (
              <button
                key={token}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertToken(token)}
                className="rounded-full border border-zinc-300 px-2.5 py-0.5 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <span className="font-mono">{`{${token}}`}</span>{' '}
                <span className="text-zinc-500">{t(`library.export.tokens.${token}`)}</span>
              </button>
            ))}
          </div>
          <OutputSettings />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || !template.trim()}
              onClick={() => void exportSelected()}
              className={primaryButton}
            >
              {t('library.export.export')}
            </button>
            <button type="button" onClick={() => setExporting(false)} className={button}>
              {t('library.common.close')}
            </button>
            {busy ? <Spinner className="h-4 w-4 text-sky-500" /> : null}
          </div>
          {files ? (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">
              {t('library.export.done', { count: files.length })}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? <ErrorNotice error={{ code: error }} /> : null}
      {items && items.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {filtered ? t('library.history.noMatch') : t('library.history.empty')}
        </p>
      ) : null}
      <ul className="space-y-2">
        {(items ?? []).map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            voices={voices ?? []}
            model={model}
            playing={player.playing}
            onPlay={player.toggle}
          />
        ))}
      </ul>
      {items && items.length < total ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void loadHistory(true).then((code) => {
              setError(code);
              setLoading(false);
            });
          }}
          className={button}
        >
          {t('library.history.more', { count: total - items.length })}
        </button>
      ) : null}
      <LimitsPanel />
    </section>
  );
}
