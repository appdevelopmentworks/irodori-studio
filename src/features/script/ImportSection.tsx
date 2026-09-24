'use client';

import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { button, card, primaryButton } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { codeOf } from '@/lib/jobs';
import { readTextFile } from '@/lib/textFile';
import type { ModelCapabilities, ScriptFormat } from '@/lib/types';
import { useScriptStore } from '@/store/script';

import { createScript, importLines } from './actions';

const FORMATS: ScriptFormat[] = ['text', 'csv', 'tsv'];
const COLUMNS = new Set(['candidates', 'seed', 'pause_ms']);

function formatOf(name: string, text: string): ScriptFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return 'tsv';
  if (lower.endsWith('.txt')) return 'text';
  return text.split('\n', 1)[0]?.includes('\t') ? 'tsv' : 'text';
}

type ImportError =
  | { kind: 'code'; code: string }
  | { kind: 'empty' | 'header' }
  | { kind: 'value'; row: number; column: string }
  | { kind: 'range'; line: number };

/** Why a script could not be read, from `script_invalid`'s detail. */
function importErrorOf(err: unknown): ImportError {
  if (!(err instanceof ApiError) || err.code !== 'script_invalid') {
    return { kind: 'code', code: codeOf(err) };
  }
  const { reason, row, column, line } = err.detail;
  if (reason === 'empty' || reason === 'header') return { kind: reason };
  if (reason === 'value' && typeof row === 'number' && typeof column === 'string') {
    return { kind: 'value', row, column };
  }
  if (reason === 'value' && typeof line === 'number') return { kind: 'range', line };
  return { kind: 'code', code: err.code };
}

/** Lines from "話者：セリフ" text or a CSV / TSV table: a new script, or more lines for
 * the open one (appended or replacing every line). */
export function ImportSection({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const sourceId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const source = useScriptStore((s) => s.source);
  const format = useScriptStore((s) => s.format);
  const script = useScriptStore((s) => s.script);
  const rendering = useScriptStore((s) => s.job !== null && s.job.finishedAt === null);
  const setSource = useScriptStore((s) => s.setSource);
  const setFormat = useScriptStore((s) => s.setFormat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ImportError | null>(null);
  const [confirming, setConfirming] = useState(false);

  const hasTakes = script?.lines.some((line) => line.takes.length > 0) ?? false;

  const run = async (action: () => Promise<void>) => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(importErrorOf(err));
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await readTextFile(file);
      setSource(text, formatOf(file.name, text));
      setError(null);
    } catch {
      setError({ kind: 'code', code: 'internal' });
    }
  };

  let message: string | null = null;
  if (error?.kind === 'empty' || error?.kind === 'header') {
    message = t(`script.importErrors.${error.kind}`);
  } else if (error?.kind === 'value') {
    const column = COLUMNS.has(error.column)
      ? t(`script.columns.${error.column as 'candidates' | 'seed' | 'pause_ms'}`)
      : error.column;
    message = t('script.importErrors.value', { row: error.row, column });
  } else if (error?.kind === 'range') {
    message = t('script.importErrors.range', { line: error.line });
  }

  const body = (
    <div className="space-y-3">
      <textarea
        id={sourceId}
        lang="ja"
        rows={script ? 6 : 10}
        aria-label={script ? t('script.source.addTitle') : undefined}
        value={source}
        placeholder={t('script.source.placeholder')}
        onChange={(event) => setSource(event.target.value)}
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="flex flex-wrap items-center gap-4">
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.csv,.tsv,.tab,text/plain,text/csv,text/tab-separated-values"
          hidden
          onChange={(event) => {
            void importFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <button type="button" onClick={() => fileInput.current?.click()} className={button}>
          {t('script.source.import')}
        </button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500">{t('script.source.format')}</span>
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as ScriptFormat)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {FORMATS.map((option) => (
              <option key={option} value={option}>
                {t(`script.formats.${option}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-zinc-500">
        {format === 'text' ? t('script.source.textHint') : t('script.source.tableHint')}
      </p>
      {message ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {message}
        </p>
      ) : error?.kind === 'code' ? (
        <ErrorNotice error={{ code: error.code }} />
      ) : null}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <span className="flex-1">{t('script.source.replaceConfirm')}</span>
          <button
            type="button"
            onClick={() => void run(() => importLines('replace'))}
            className={primaryButton}
          >
            {t('script.source.replace')}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={button}>
            {t('script.common.cancel')}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {script ? (
            <>
              <button
                type="button"
                disabled={busy || !source.trim()}
                onClick={() => void run(() => importLines('append'))}
                className={primaryButton}
              >
                {t('script.source.append')}
              </button>
              <button
                type="button"
                disabled={busy || rendering || !source.trim()}
                onClick={() =>
                  hasTakes ? setConfirming(true) : void run(() => importLines('replace'))
                }
                className={button}
              >
                {t('script.source.replace')}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || !source.trim()}
              onClick={() => void run(() => createScript(model.params))}
              className={primaryButton}
            >
              {t('script.source.create')}
            </button>
          )}
          {busy ? <Spinner className="h-4 w-4 text-sky-500" /> : null}
        </div>
      )}
    </div>
  );

  if (!script) {
    return (
      <section className={`${card} space-y-3`}>
        <label htmlFor={sourceId} className="text-sm font-semibold">
          {t('script.source.title')}
        </label>
        {body}
      </section>
    );
  }
  return (
    <details className={`${card} group`}>
      <summary className="cursor-pointer text-sm font-semibold select-none">
        {t('script.source.addTitle')}
      </summary>
      <div className="pt-3">{body}</div>
    </details>
  );
}
