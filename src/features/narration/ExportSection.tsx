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
import { pickSavePath } from '@/lib/tauri';
import type { ExportedFile, ModelCapabilities } from '@/lib/types';
import { useNarrationStore } from '@/store/narration';
import { useSidecarStore } from '@/store/sidecar';

import { saveSettings } from './actions';

/** Join the adopted takes with the pauses (or at the SRT cue times), listen, and export
 * one file with SRT / WebVTT subtitles and, optionally, one file per chunk. */
export function ExportSection({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const ffmpeg = useSidecarStore((s) => s.system?.ffmpeg_available ?? false);
  const preferences = useSidecarStore((s) => s.preferences);
  const narration = useNarrationStore((s) => s.narration);
  const busyRender = useNarrationStore((s) => isBusy(s.job));
  const [srt, setSrt] = useState(true);
  const [vtt, setVtt] = useState(false);
  const [perChunk, setPerChunk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<ExportedFile[] | null>(null);

  if (!api || !narration) return null;

  const missing = narration.chunks.filter((chunk) => !chunk.adopted_audio_id).length;
  const output = usableOutput(preferences?.output, ffmpeg);
  const chosen = output.format;
  const assembled = narration.assembled;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await saveSettings(model.params); // pauses count for the assembly
      await action();
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const assemble = () =>
    run(async () => {
      const result = await api.assembleNarration(narration.id);
      const state = useNarrationStore.getState();
      if (state.narration?.id === narration.id) {
        state.replace({ ...state.narration, assembled: result });
      }
    });

  const exportFiles = () =>
    run(async () => {
      const path = await pickSavePath(
        t('narration.export.dialogTitle'),
        `${narration.title.replace(/[\\/:*?"<>|]/g, '_')}.${chosen}`,
        [{ name: t(`output.formats.${chosen}`), extensions: [chosen] }],
      );
      if (!path) return;
      const subtitles = [...(srt ? ['srt' as const] : []), ...(vtt ? ['vtt' as const] : [])];
      const result = await api.exportNarration(narration.id, {
        path,
        format: chosen,
        subtitles,
        per_chunk: perChunk,
        post: postOf(output),
      });
      setFiles(result.files);
      const fresh = await api.getNarration(narration.id);
      const state = useNarrationStore.getState();
      if (state.narration?.id === narration.id) state.replace(fresh);
    });

  return (
    <section className={`${card} space-y-4`}>
      <h2 className="text-sm font-semibold">{t('narration.export.title')}</h2>
      {missing > 0 ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {t('narration.export.incomplete', { missing })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || busyRender || missing > 0}
          onClick={() => void assemble()}
          className={button}
        >
          {assembled ? t('narration.export.reassemble') : t('narration.export.assemble')}
        </button>
        {busy ? <Spinner className="h-4 w-4 text-sky-500" /> : null}
        {assembled ? (
          <span className="text-xs text-zinc-500 tabular-nums">
            {t('narration.export.assembled', {
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
        <span className="flex items-center gap-3">
          <span className="text-zinc-500">{t('narration.export.subtitles')}</span>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={srt} onChange={(e) => setSrt(e.target.checked)} />
            {t('narration.export.srt')}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={vtt} onChange={(e) => setVtt(e.target.checked)} />
            {t('narration.export.vtt')}
          </label>
        </span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={perChunk}
            onChange={(e) => setPerChunk(e.target.checked)}
          />
          {t('narration.export.perChunk')}
        </label>
      </div>
      <OutputSettings />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || busyRender || missing > 0}
          onClick={() => void exportFiles()}
          className={primaryButton}
        >
          {t('narration.export.export')}
        </button>
      </div>
      {error ? <ErrorNotice error={{ code: error }} /> : null}
      {files ? (
        <div className="space-y-1 text-xs">
          <p className="text-emerald-700 dark:text-emerald-400">{t('narration.export.done')}</p>
          <ul className="space-y-0.5 text-zinc-600 dark:text-zinc-400">
            {files.map((file) => (
              <li key={file.path} className="font-mono break-all">
                {file.path}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
