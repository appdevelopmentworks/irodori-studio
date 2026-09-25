'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorCodeOf } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { openFolder, readLog } from '@/lib/tauri';
import type { LogName, LogTail } from '@/lib/types';

import { CopyButton } from './CopyButton';
import { ErrorNotice } from './ErrorNotice';
import { button, smallButton } from './ui';

const LOGS: LogName[] = ['sidecar', 'setup'];

/** The end of the sidecar or setup log, read through Rust (works while the sidecar is
 * down, e.g. on the error screen). */
export function LogViewer({ initial = 'sidecar' }: { initial?: LogName }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const selectId = useId();
  const [name, setName] = useState<LogName>(initial);
  const [reads, setReads] = useState(0);
  const [log, setLog] = useState<LogTail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let active = true;
    readLog(name)
      .then((tail) => {
        if (!active) return;
        setLog(tail);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active) setError(errorCodeOf(err));
      });
    return () => {
      active = false;
    };
  }, [name, reads]);

  useEffect(() => {
    const pre = preRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [log]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-xs text-zinc-500">
          {t('settings.logs.file')}
        </label>
        <select
          id={selectId}
          value={name}
          onChange={(event) => setName(event.target.value as LogName)}
          className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {LOGS.map((id) => (
            <option key={id} value={id}>
              {t(`settings.logs.names.${id}`)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setReads((n) => n + 1)} className={smallButton}>
          {t('settings.logs.refresh')}
        </button>
        <CopyButton text={log?.text ?? ''} disabled={!log?.text} className={smallButton} />
        <button
          type="button"
          onClick={() =>
            void openFolder('logs').catch((err: unknown) => setError(errorCodeOf(err)))
          }
          className={button}
        >
          {t('settings.logs.openFolder')}
        </button>
      </div>
      {log ? (
        <p className="text-xs break-all text-zinc-500">
          {t('settings.logs.meta', {
            path: log.path,
            size: formatBytes(log.size, locale),
          })}
          {log.truncated ? ` ${t('settings.logs.truncated')}` : null}
        </p>
      ) : null}
      <pre
        ref={preRef}
        className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-200"
      >
        {log?.text || t('settings.logs.empty')}
      </pre>
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </div>
  );
}
