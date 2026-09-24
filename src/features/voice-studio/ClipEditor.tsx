'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type WaveSurfer from 'wavesurfer.js';
import type { Region } from 'wavesurfer.js/plugins/regions';

import { formatSeconds } from '@/lib/format';

import { button } from './ui';

// Pieces shorter than this are refused by the sidecar (MIN_CLIP_SECONDS).
const MIN_PIECE_SECONDS = 0.1;

interface Selection {
  start: number;
  end: number;
}

/** Waveform of one clip with head/tail trimming (drag to select, keep the selection) and
 * splitting at the playback position (requirements §6.5). Edits replace the clip. */
export function ClipEditor({
  url,
  busy,
  onTrim,
  onSplit,
}: {
  /** 16-bit WAV of the clip (`GET /clips/{id}/audio`). */
  url: string;
  busy: boolean;
  onTrim: (start: number, end: number) => void;
  onSplit: (at: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<WaveSurfer | null>(null);
  const selected = useRef<Region | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    let disposed = false;
    let wavesurfer: WaveSurfer | null = null;
    void (async () => {
      // Loaded on demand: wavesurfer needs the DOM (static export pre-renders pages).
      const [{ default: WaveSurferClass }, { default: RegionsPlugin }] = await Promise.all([
        import('wavesurfer.js'),
        import('wavesurfer.js/plugins/regions'),
      ]);
      if (disposed || !container.current) return;
      const regions = RegionsPlugin.create();
      wavesurfer = WaveSurferClass.create({
        container: container.current,
        url,
        height: 80,
        waveColor: '#a1a1aa',
        progressColor: '#0284c7',
        cursorColor: '#0ea5e9',
        cursorWidth: 2,
        normalize: true,
        plugins: [regions],
      });
      player.current = wavesurfer;
      regions.enableDragSelection({ color: 'rgba(14, 165, 233, 0.2)' });
      const show = (region: Region) => setSelection({ start: region.start, end: region.end });
      regions.on('region-created', (region) => {
        // One selection at a time.
        for (const other of regions.getRegions()) if (other !== region) other.remove();
        selected.current = region;
        show(region);
      });
      regions.on('region-updated', (region) => {
        if (region === selected.current) show(region);
      });
      regions.on('region-removed', (region) => {
        if (region !== selected.current) return;
        selected.current = null;
        setSelection(null);
      });
      wavesurfer.on('ready', (seconds) => setDuration(seconds));
      wavesurfer.on('error', () => setFailed(true));
      wavesurfer.on('play', () => setPlaying(true));
      wavesurfer.on('pause', () => setPlaying(false));
      wavesurfer.on('finish', () => setPlaying(false));
      wavesurfer.on('timeupdate', (seconds) => setTime(seconds));
    })().catch(() => setFailed(true));
    return () => {
      disposed = true;
      wavesurfer?.destroy();
      player.current = null;
      selected.current = null;
    };
  }, [url]);

  const ready = duration !== null;
  const canSplit =
    ready && time >= MIN_PIECE_SECONDS && duration - time >= MIN_PIECE_SECONDS && !busy;
  const canTrim =
    ready && selection !== null && selection.end - selection.start >= MIN_PIECE_SECONDS && !busy;
  const seconds = (value: number) => formatSeconds(value, locale, 2);

  return (
    <div className="space-y-2">
      <div
        ref={container}
        className="min-h-20 rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950"
      />
      {failed ? (
        <p className="text-xs text-red-700 dark:text-red-300">{t('voiceStudio.editor.loadFailed')}</p>
      ) : (
        <p className="text-xs text-zinc-500">{t('voiceStudio.editor.hint')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() => void player.current?.playPause()}
          className={button}
        >
          {playing ? t('voiceStudio.editor.pause') : t('voiceStudio.editor.play')}
        </button>
        <button
          type="button"
          disabled={!ready || selection === null}
          onClick={() => selected.current?.play(true)}
          className={button}
        >
          {t('voiceStudio.editor.playSelection')}
        </button>
        <button
          type="button"
          disabled={!canTrim}
          onClick={() => selection && onTrim(selection.start, selection.end)}
          className={button}
        >
          {t('voiceStudio.editor.trim')}
        </button>
        <button
          type="button"
          disabled={!canSplit}
          onClick={() => onSplit(time)}
          className={button}
        >
          {t('voiceStudio.editor.split')}
        </button>
        {selection ? (
          <button
            type="button"
            onClick={() => selected.current?.remove()}
            className="text-xs text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
          >
            {t('voiceStudio.editor.clearSelection')}
          </button>
        ) : null}
        <span className="ml-auto text-xs text-zinc-500 tabular-nums">
          {ready
            ? t('voiceStudio.editor.position', {
                current: seconds(time),
                total: seconds(duration),
              })
            : null}
        </span>
      </div>
      {selection ? (
        <p className="text-xs text-zinc-600 tabular-nums dark:text-zinc-400">
          {t('voiceStudio.editor.selection', {
            start: seconds(selection.start),
            end: seconds(selection.end),
            length: seconds(selection.end - selection.start),
          })}
        </p>
      ) : null}
    </div>
  );
}
