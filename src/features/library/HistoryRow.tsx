'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { PlayIcon, Spinner, StopIcon } from '@/components/icons';
import { button, dangerButton } from '@/components/ui';
import type { ParamName, ParamValue } from '@/features/params/schema';
import { useParamText } from '@/features/params/text';
import { formatDateTime, formatSeconds } from '@/lib/format';
import { codeOf } from '@/lib/jobs';
import { pickSavePath } from '@/lib/tauri';
import type { HistorySummary, ModelCapabilities, Voice } from '@/lib/types';
import { useLibraryStore } from '@/store/library';
import { useSidecarStore } from '@/store/sidecar';

import { adopt, currentOutput, regenerate, remove, reuse, saveCandidate } from './actions';

const small = `${button} px-2 py-1 text-xs`;

/** One history entry: text, voice, candidates to play and adopt, and what to do with it
 * (generate again, reuse its settings, save, details, delete). */
export function HistoryRow({
  entry,
  voices,
  model,
  playing,
  onPlay,
}: {
  entry: HistorySummary;
  voices: Voice[];
  model: ModelCapabilities;
  playing: string | null;
  onPlay: (audioId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const text = useParamText();
  const api = useSidecarStore((s) => s.api);
  const selected = useLibraryStore((s) => s.selected.includes(entry.id));
  const detail = useLibraryStore((s) => s.details[entry.id]);
  const job = useLibraryStore((s) => s.jobs[entry.id]);
  const rowError = useLibraryStore((s) => s.errors[entry.id]);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  if (!api) return null;

  const setError = (code: string | null) => useLibraryStore.getState().setError(entry.id, code);
  const voice = voices.find((v) => v.id === entry.voice_id);
  let voiceLabel: string;
  if (entry.voice_id) voiceLabel = voice?.name ?? t('library.history.voiceDeleted');
  else voiceLabel = t(`library.history.reference.${entry.reference_kind}`);
  const chosen =
    entry.outputs.find((o) => o.audio_id === entry.adopted_audio_id) ?? entry.outputs[0];

  const toggleDetails = async () => {
    if (!open && !detail) {
      try {
        useLibraryStore.getState().setDetail(entry.id, await api.getHistoryEntry(entry.id));
      } catch (err) {
        setError(codeOf(err));
        return;
      }
    }
    setOpen((value) => !value);
  };

  const save = async () => {
    if (!chosen) return;
    const output = currentOutput();
    const stamp = entry.created_at.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const path = await pickSavePath(
      t('library.history.saveTitle'),
      `irodori_${stamp}_${chosen.index + 1}.${output.format}`,
      [{ name: t(`output.formats.${output.format}`), extensions: [output.format] }],
    );
    if (!path) return;
    try {
      setSaved(await saveCandidate(chosen.audio_id, path));
      setError(null);
    } catch (err) {
      setError(codeOf(err));
    }
  };

  const busy = job !== undefined;
  const params = detail
    ? (Object.entries(detail.params) as [ParamName, ParamValue][]).filter(([name]) =>
        model.params.some((p) => p.name === name),
      )
    : [];

  return (
    <li className="space-y-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          aria-label={t('library.history.select')}
          onChange={() => useLibraryStore.getState().toggle(entry.id)}
          className="mt-1"
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span className="tabular-nums">{formatDateTime(entry.created_at, locale)}</span>
            {entry.source === 'api' ? (
              <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-200">
                {t('library.history.fromApi')}
              </span>
            ) : null}
            <span>{voiceLabel}</span>
            <span className="tabular-nums">{t('library.history.seed', { seed: entry.used_seed })}</span>
            {busy ? (
              <span className="flex items-center gap-1.5 text-sky-700 dark:text-sky-400">
                <Spinner className="h-3.5 w-3.5" />
                {job === 'running' ? t('library.history.running') : t('library.history.queued')}
              </span>
            ) : null}
          </div>
          <p lang="ja" className="line-clamp-2 leading-relaxed">
            {entry.text}
          </p>
          {entry.caption ? (
            <p lang="ja" className="truncate text-xs text-zinc-500">
              {t('library.history.caption', { caption: entry.caption })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {entry.outputs.map((output) => {
              const adopted = output.audio_id === entry.adopted_audio_id;
              return (
                <span
                  key={output.audio_id}
                  className={`flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-0.5 text-xs ${
                    adopted
                      ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40'
                      : 'border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  <button
                    type="button"
                    aria-label={
                      playing === output.audio_id
                        ? t('library.history.stop', { index: output.index + 1 })
                        : t('library.history.play', { index: output.index + 1 })
                    }
                    onClick={() => onPlay(output.audio_id)}
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-600 text-white hover:bg-sky-700"
                  >
                    {playing === output.audio_id ? (
                      <StopIcon className="h-3.5 w-3.5" />
                    ) : (
                      <PlayIcon className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <span className="tabular-nums">
                    {t('library.history.candidate', {
                      index: output.index + 1,
                      seconds: formatSeconds(output.duration_s, locale),
                    })}
                  </span>
                  <button
                    type="button"
                    aria-pressed={adopted}
                    onClick={() => void adopt(entry, adopted ? null : output.audio_id)}
                    className="rounded px-1 text-sky-700 hover:bg-sky-100 dark:text-sky-400 dark:hover:bg-sky-900"
                  >
                    {adopted ? t('library.history.adopted') : t('library.history.adopt')}
                  </button>
                </span>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void regenerate(entry, false)}
              className={small}
            >
              {t('library.history.again')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void regenerate(entry, true)}
              className={small}
            >
              {t('library.history.againNewSeed')}
            </button>
            <button
              type="button"
              onClick={() => void reuse(entry, model.params).then(setError, (err) => setError(codeOf(err)))}
              className={small}
            >
              {t('library.history.reuse')}
            </button>
            <button type="button" disabled={!chosen} onClick={() => void save()} className={small}>
              {t('library.history.save')}
            </button>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => void toggleDetails()}
              className={small}
            >
              {open ? t('library.history.hideDetails') : t('library.history.details')}
            </button>
            {deleting ? (
              <>
                <button
                  type="button"
                  onClick={() => void remove([entry.id]).then(setError)}
                  className={`${dangerButton} px-2 py-1 text-xs`}
                >
                  {t('library.history.deleteConfirm')}
                </button>
                <button type="button" onClick={() => setDeleting(false)} className={small}>
                  {t('library.common.cancel')}
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setDeleting(true)} className={small}>
                {t('library.history.delete')}
              </button>
            )}
          </div>
          {saved ? (
            <p className="text-xs break-all text-emerald-700 dark:text-emerald-400">
              {t('library.history.saved', { path: saved })}
            </p>
          ) : null}
          {open && detail ? (
            <div className="space-y-2 rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-800/60">
              <ul className="flex flex-wrap gap-1.5">
                {params.map(([name, value]) => {
                  const param = model.params.find((p) => p.name === name);
                  return param ? (
                    <li key={name} className="rounded-full bg-white px-2 py-0.5 dark:bg-zinc-900">
                      {t('library.presets.value', {
                        name: text.label(name),
                        value: text.valueLabel(param, value),
                      })}
                    </li>
                  ) : null;
                })}
              </ul>
              <p className="text-zinc-500">
                {t('library.history.run', {
                  device: detail.device,
                  precision: detail.precision,
                  seconds: formatSeconds(
                    (detail.timings.synthesize ?? detail.timings.total_to_decode ?? 0) / 1000,
                    locale,
                    2,
                  ),
                })}
              </p>
            </div>
          ) : null}
          {rowError ? <ErrorNotice error={{ code: rowError }} /> : null}
        </div>
      </div>
    </li>
  );
}
