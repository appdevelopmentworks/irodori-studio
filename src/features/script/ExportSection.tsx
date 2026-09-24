'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { button, card, primaryButton } from '@/components/ui';
import { postOf, usableOutput } from '@/features/output/output';
import { OutputSettings } from '@/features/output/OutputSettings';
import { formatClock } from '@/lib/format';
import { codeOf, isBusy } from '@/lib/jobs';
import { pickDirectory, pickSavePath } from '@/lib/tauri';
import type { ExportedFile, ModelCapabilities } from '@/lib/types';
import { useScriptStore } from '@/store/script';
import { useSidecarStore } from '@/store/sidecar';

import { saveSettings } from './actions';

const LISTED_FILES = 8;
// Characters a file name may not contain on Windows or macOS.
const UNSAFE = /[\\/:*?"<>|]/g;

/** Join the adopted takes with the pauses and listen; export one file per line (named by
 * the template), the merged drama with SRT / WebVTT subtitles, and the lines as a table. */
export function ExportSection({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const ffmpeg = useSidecarStore((s) => s.system?.ffmpeg_available ?? false);
  const preferences = useSidecarStore((s) => s.preferences);
  const script = useScriptStore((s) => s.script);
  const busyRender = useScriptStore((s) => isBusy(s.job));
  const [perLine, setPerLine] = useState(true);
  const [merged, setMerged] = useState(true);
  const [srt, setSrt] = useState(true);
  const [vtt, setVtt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ExportedFile[] | null>(null);
  const [table, setTable] = useState<string | null>(null);

  if (!api || !script) return null;

  const missing = script.lines.filter((line) => !line.adopted_audio_id).length;
  const output = usableOutput(preferences?.output, ffmpeg);
  const chosen = output.format;
  const assembled = script.assembled;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await saveSettings(model.params); // pauses, names and subtitles count here
      await action();
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    const fresh = await api.getScript(script.id);
    const state = useScriptStore.getState();
    if (state.script?.id === script.id) state.replace(fresh);
  };

  const assemble = () =>
    run(async () => {
      const result = await api.assembleScript(script.id);
      const state = useScriptStore.getState();
      if (state.script?.id === script.id) {
        state.replace({ ...state.script, assembled: result });
      }
    });

  const exportFiles = () =>
    run(async () => {
      const folder = await pickDirectory(t('script.export.folderTitle'));
      if (!folder) return;
      const subtitles = [...(srt ? ['srt' as const] : []), ...(vtt ? ['vtt' as const] : [])];
      const result = await api.exportScript(script.id, {
        folder,
        format: chosen,
        per_line: perLine,
        merged,
        subtitles: merged ? subtitles : [],
        post: postOf(output),
      });
      setFiles(result.files);
      await refresh();
    });

  const exportTable = () =>
    run(async () => {
      const path = await pickSavePath(
        t('script.export.tableTitle'),
        `${script.title.replace(UNSAFE, '_')}.csv`,
        [
          { name: t('script.export.csv'), extensions: ['csv'] },
          { name: t('script.export.tsv'), extensions: ['tsv'] },
        ],
      );
      if (!path) return;
      const saved = await api.exportScriptTable(script.id, {
        path,
        format: path.toLowerCase().endsWith('.tsv') ? 'tsv' : 'csv',
      });
      setTable(saved.path);
    });

  return (
    <section className={`${card} space-y-4`}>
      <h2 className="text-sm font-semibold">{t('script.export.title')}</h2>
      {missing > 0 ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {t('script.export.incomplete', { count: missing })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || busyRender || missing > 0}
          onClick={() => void assemble()}
          className={button}
        >
          {assembled ? t('script.export.reassemble') : t('script.export.assemble')}
        </button>
        {busy ? <Spinner className="h-4 w-4 text-sky-500" /> : null}
        {assembled ? (
          <span className="text-xs text-zinc-500 tabular-nums">
            {t('script.export.assembled', {
              duration: formatClock(assembled.duration_s),
              cues: assembled.cues.length,
            })}
          </span>
        ) : null}
      </div>
      {assembled ? (
        // Generated speech has no caption track; the subtitles are exported alongside.
        <audio controls preload="metadata" src={api.audioUrl(assembled.audio_id)} className="w-full" />
      ) : null}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={perLine} onChange={(e) => setPerLine(e.target.checked)} />
          {t('script.export.perLine')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={merged} onChange={(e) => setMerged(e.target.checked)} />
          {t('script.export.merged')}
        </label>
        <span className="flex items-center gap-3">
          <span className="text-zinc-500">{t('script.export.subtitles')}</span>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={srt}
              disabled={!merged}
              onChange={(e) => setSrt(e.target.checked)}
            />
            {t('script.export.srt')}
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={vtt}
              disabled={!merged}
              onChange={(e) => setVtt(e.target.checked)}
            />
            {t('script.export.vtt')}
          </label>
        </span>
      </div>
      <OutputSettings />
      <p className="text-xs text-zinc-500">{t('script.export.overwrite')}</p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || busyRender || missing > 0 || (!perLine && !merged)}
          onClick={() => void exportFiles()}
          className={primaryButton}
        >
          {t('script.export.export')}
        </button>
      </div>
      {error ? <ErrorNotice error={{ code: error }} /> : null}
      {files ? (
        <div className="space-y-1 text-xs">
          <p className="text-emerald-700 dark:text-emerald-400">
            {t('script.export.done', { count: files.length })}
          </p>
          <ul className="space-y-0.5 text-zinc-600 dark:text-zinc-400">
            {files.slice(0, LISTED_FILES).map((file) => (
              <li key={file.path} className="font-mono break-all">
                {file.path}
              </li>
            ))}
          </ul>
          {files.length > LISTED_FILES ? (
            <p className="text-zinc-500">
              {t('script.export.more', { count: files.length - LISTED_FILES })}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy} onClick={() => void exportTable()} className={button}>
            {t('script.export.table')}
          </button>
          <p className="text-xs text-zinc-500">{t('script.export.tableHint')}</p>
        </div>
        {table ? (
          <p className="text-xs break-all text-emerald-700 dark:text-emerald-400">
            {t('script.export.tableDone', { path: table })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
