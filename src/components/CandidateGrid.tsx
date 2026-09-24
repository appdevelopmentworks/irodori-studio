'use client';

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { formatSeconds } from '@/lib/format';
import type { AudioOutput } from '@/lib/types';

interface CandidateGridProps {
  outputs: AudioOutput[];
  audioUrl: (audioId: string) => string;
  adoptedId: string | null;
  onAdopt: (audioId: string | null) => void;
  onSave: (output: AudioOutput) => void;
  /** audio_id → where a copy was saved. */
  saved: Record<string, string>;
  /** Start playing the first candidate (a fresh result). */
  autoPlayFirst?: boolean;
}

/** Candidates side by side to listen, adopt one, and save copies (requirements §6.3). */
export function CandidateGrid({
  outputs,
  audioUrl,
  adoptedId,
  onAdopt,
  onSave,
  saved,
  autoPlayFirst = false,
}: CandidateGridProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const first = useRef<HTMLAudioElement>(null);

  // play() rather than the autoplay attribute: the caller clears the flag right after,
  // which must not cancel playback that has not started yet.
  useEffect(() => {
    if (autoPlayFirst) first.current?.play().catch(() => undefined);
  }, [autoPlayFirst, outputs]);

  return (
    <ul className={`grid gap-3 ${outputs.length > 1 ? 'sm:grid-cols-2' : ''}`}>
      {outputs.map((output) => {
        const adopted = output.audio_id === adoptedId;
        return (
          <li
            key={output.audio_id}
            className={`space-y-2 rounded-lg border bg-white p-3 dark:bg-zinc-900 ${
              adopted
                ? 'border-sky-500 ring-1 ring-sky-500'
                : 'border-zinc-200 dark:border-zinc-800'
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">
                {t('quick.candidates.item', { index: output.index + 1 })}
              </span>
              <span className="text-xs text-zinc-500 tabular-nums">
                {t('quick.candidates.duration', {
                  seconds: formatSeconds(output.duration_s, locale, 2),
                })}
              </span>
            </div>
            {/* Generated speech has no caption track. */}
            <audio
              ref={output.index === 0 ? first : undefined}
              controls
              preload="metadata"
              src={audioUrl(output.audio_id)}
              className="w-full"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={adopted}
                onClick={() => onAdopt(adopted ? null : output.audio_id)}
                className={`rounded-md border px-3 py-1 text-sm ${
                  adopted
                    ? 'border-sky-600 bg-sky-600 text-white'
                    : 'border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
                }`}
              >
                {adopted ? t('quick.candidates.adopted') : t('quick.candidates.adopt')}
              </button>
              <button
                type="button"
                onClick={() => onSave(output)}
                className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                {t('quick.candidates.save')}
              </button>
            </div>
            {saved[output.audio_id] ? (
              <p className="text-xs break-all text-emerald-700 dark:text-emerald-400">
                {t('quick.candidates.saved', { path: saved[output.audio_id] })}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
