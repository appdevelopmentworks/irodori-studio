'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { button } from '@/components/ui';
import { formatSeconds } from '@/lib/format';

import { type MicError, micErrorOf, type MicLevel, MicRecorder } from './mic';

/** Guide sentences to read aloud (`voiceStudio.record.sentences.<id>`, per locale). */
const SENTENCES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'] as const;

/** Recommended amount of reference speech (requirements §6.5). */
export const TARGET_SECONDS = 30;

type Status = 'idle' | 'starting' | 'recording' | 'stopping';

const QUIET_RMS = 0.01; // about -40 dBFS
// "Too quiet" looks at the loudest block of the last ~2 s (blocks are ~50 ms), so the
// pauses between words do not trigger it.
const QUIET_BLOCKS = 40;
const CLIP_PEAK = 0.99;

/** Microphone recording with guide sentences and a level meter. Each take is handed to
 * `onTake` as WAV (uploaded as a clip with origin "recording" by the caller). */
export function Recorder({
  collectedSeconds,
  disabled,
  onTake,
}: {
  /** Reference audio gathered so far (all clips). */
  collectedSeconds: number;
  disabled?: boolean;
  onTake: (wav: Blob, seconds: number) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const recorder = useRef<MicRecorder | null>(null);
  const recent = useRef<number[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<MicError | null>(null);
  const [level, setLevel] = useState<MicLevel>({ peak: 0, rms: 0 });
  const [seconds, setSeconds] = useState(0);
  const [clipped, setClipped] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [index, setIndex] = useState(0);

  // Leaving the screen mid-take releases the microphone.
  useEffect(
    () => () => {
      void recorder.current?.cancel();
      recorder.current = null;
    },
    [],
  );

  const start = async () => {
    setError(null);
    setClipped(false);
    setQuiet(false);
    setSeconds(0);
    setLevel({ peak: 0, rms: 0 });
    setStatus('starting');
    recent.current = [];
    const mic = new MicRecorder((next, elapsed) => {
      setLevel(next);
      setSeconds(elapsed);
      if (next.peak >= CLIP_PEAK) setClipped(true);
      const blocks = recent.current;
      blocks.push(next.rms);
      if (blocks.length > QUIET_BLOCKS) blocks.shift();
      setQuiet(blocks.length >= QUIET_BLOCKS && Math.max(...blocks) < QUIET_RMS);
    });
    recorder.current = mic;
    try {
      await mic.start();
      setStatus('recording');
    } catch (err) {
      recorder.current = null;
      setError(micErrorOf(err));
      setStatus('idle');
    }
  };

  const stop = async () => {
    const mic = recorder.current;
    if (!mic) return;
    setStatus('stopping');
    const take = await mic.stop();
    recorder.current = null;
    if (take) {
      await onTake(take.wav, take.seconds);
      setIndex((i) => (i + 1) % SENTENCES.length);
    }
    setStatus('idle');
  };

  const discard = async () => {
    await recorder.current?.cancel();
    recorder.current = null;
    setStatus('idle');
  };

  const recording = status === 'recording';
  const total = collectedSeconds + (recording ? seconds : 0);
  // Meter on a dB scale: -60 dBFS .. 0 dBFS.
  const db = level.rms > 0 ? 20 * Math.log10(level.rms) : -60;
  const meter = Math.max(0, Math.min(1, (db + 60) / 60));

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="text-xs text-zinc-500">{t('voiceStudio.record.hint')}</p>

      <div className="space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/60">
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
          <span>
            {t('voiceStudio.record.sentence', { index: index + 1, count: SENTENCES.length })}
          </span>
          <span className="flex gap-1">
            <button
              type="button"
              disabled={recording}
              onClick={() => setIndex((i) => (i + SENTENCES.length - 1) % SENTENCES.length)}
              className="rounded px-2 py-0.5 hover:bg-zinc-200 disabled:opacity-40 dark:hover:bg-zinc-700"
            >
              {t('voiceStudio.record.previous')}
            </button>
            <button
              type="button"
              disabled={recording}
              onClick={() => setIndex((i) => (i + 1) % SENTENCES.length)}
              className="rounded px-2 py-0.5 hover:bg-zinc-200 disabled:opacity-40 dark:hover:bg-zinc-700"
            >
              {t('voiceStudio.record.next')}
            </button>
          </span>
        </div>
        <p className="text-lg leading-relaxed">
          {t(`voiceStudio.record.sentences.${SENTENCES[index]}`)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {recording || status === 'stopping' ? (
          <>
            <button
              type="button"
              disabled={status === 'stopping'}
              onClick={() => void stop()}
              className="flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-white" />
              {t('voiceStudio.record.stop')}
            </button>
            <button
              type="button"
              disabled={status === 'stopping'}
              onClick={() => void discard()}
              className={button}
            >
              {t('voiceStudio.record.discard')}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={disabled || status === 'starting'}
            onClick={() => void start()}
            className="flex items-center gap-2 rounded-md border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
          >
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-red-600" />
            {t('voiceStudio.record.start')}
          </button>
        )}
        {recording ? (
          <span className="text-sm text-zinc-600 tabular-nums dark:text-zinc-400">
            {t('voiceStudio.record.elapsed', { seconds: formatSeconds(seconds, locale) })}
          </span>
        ) : null}
      </div>

      {recording ? (
        <div className="space-y-1">
          <div
            role="meter"
            aria-label={t('voiceStudio.record.level')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(meter * 100)}
            className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          >
            <div
              className={`h-full transition-[width] duration-75 ${
                level.peak >= CLIP_PEAK ? 'bg-red-500' : meter > 0.8 ? 'bg-amber-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${meter * 100}%` }}
            />
          </div>
          {clipped ? (
            <p className="text-xs text-red-700 dark:text-red-300">{t('voiceStudio.record.clipped')}</p>
          ) : null}
          {quiet && !clipped ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">{t('voiceStudio.record.quiet')}</p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-zinc-500 tabular-nums">
          <span>{t('voiceStudio.record.collected')}</span>
          <span>
            {t('voiceStudio.record.collectedValue', {
              seconds: formatSeconds(total, locale, 0),
              target: TARGET_SECONDS,
            })}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full bg-sky-500"
            style={{ width: `${Math.min(1, total / TARGET_SECONDS) * 100}%` }}
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {t(`voiceStudio.record.errors.${error}`)}
        </p>
      ) : null}
    </div>
  );
}
