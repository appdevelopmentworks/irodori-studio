'use client';

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { ChevronIcon } from '@/components/icons';
import type { LoudnessTarget, OutputOptions, SampleRate } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';

import { FORMATS, rateOf, usableOutput } from './output';

const RATES: SampleRate[] = [48000, 44100];
// Loudness presets: streaming, podcasts and the web, broadcast (EBU R128).
const LOUDNESS: [LoudnessTarget, 'streaming' | 'podcast' | 'broadcast'][] = [
  [-14, 'streaming'],
  [-16, 'podcast'],
  [-23, 'broadcast'],
];
const select =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900';

/** A number field that saves when it is left (clamped to [min, max]). */
function NumberField({
  id,
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(String(value));
  }
  const commit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || text.trim() === '') {
      setText(String(value));
      return;
    }
    const next = Math.min(Math.max(parsed, min), max);
    setText(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      disabled={disabled}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
      className={`${select} tabular-nums`}
    />
  );
}

/** The export settings every screen shares (D20) — format, sample rate, loudness, tempo
 * and gain — saved in preferences. Without ffmpeg only WAV as generated is possible. */
export function OutputSettings({ open = false }: { open?: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const ids = { format: useId(), rate: useId(), loudness: useId(), tempo: useId(), gain: useId() };
  const preferences = useSidecarStore((s) => s.preferences);
  const ffmpeg = useSidecarStore((s) => s.system?.ffmpeg_available ?? false);
  const updatePreferences = useSidecarStore((s) => s.updatePreferences);
  const [error, setError] = useState<string | null>(null);
  const output = usableOutput(preferences?.output, ffmpeg);

  const change = async (patch: Partial<OutputOptions>) => {
    setError(await updatePreferences({ output: { ...output, ...patch } }));
  };
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);

  const parts = [
    t(`output.formats.${output.format}`),
    t('output.summary.rate', { value: number(rateOf(output) / 1000, 1) }),
  ];
  if (output.loudness !== null) parts.push(t('output.summary.loudness', { value: output.loudness }));
  if (output.tempo !== 1) parts.push(t('output.summary.tempo', { value: number(output.tempo, 2) }));
  if (output.loudness === null && output.gain_db !== 0) {
    const sign = output.gain_db > 0 ? '+' : '';
    parts.push(t('output.summary.gain', { value: `${sign}${number(output.gain_db, 1)}` }));
  }

  return (
    <details
      open={open}
      className="group rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <summary className="flex cursor-pointer items-center gap-2 select-none [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-90" />
        <span className="font-medium">{t('output.title')}</span>
        <span className="truncate text-zinc-500">{parts.join(t('output.summary.separator'))}</span>
      </summary>
      <div className="grid gap-3 pt-3 sm:grid-cols-2 lg:grid-cols-5">
        <label htmlFor={ids.format} className="space-y-1">
          <span className="block text-xs text-zinc-500">{t('output.format')}</span>
          <select
            id={ids.format}
            value={output.format}
            disabled={!ffmpeg}
            onChange={(event) => void change({ format: event.target.value as OutputOptions['format'] })}
            className={select}
          >
            {FORMATS.map((format) => (
              <option key={format} value={format}>
                {t(`output.formats.${format}`)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.rate} className="space-y-1">
          <span className="block text-xs text-zinc-500">{t('output.sampleRate')}</span>
          <select
            id={ids.rate}
            value={rateOf(output)}
            disabled={!ffmpeg || output.format === 'opus'}
            onChange={(event) =>
              void change({ sample_rate: Number(event.target.value) as SampleRate })
            }
            className={select}
          >
            {RATES.map((rate) => (
              <option key={rate} value={rate}>
                {t('output.summary.rate', { value: number(rate / 1000, 1) })}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.loudness} className="space-y-1">
          <span className="block text-xs text-zinc-500">{t('output.loudness')}</span>
          <select
            id={ids.loudness}
            value={output.loudness ?? ''}
            disabled={!ffmpeg}
            onChange={(event) =>
              void change({
                loudness: event.target.value ? (Number(event.target.value) as LoudnessTarget) : null,
              })
            }
            className={select}
          >
            <option value="">{t('output.loudnessOff')}</option>
            {LOUDNESS.map(([target, key]) => (
              <option key={target} value={target}>
                {t(`output.loudnessPresets.${key}`)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={ids.tempo} className="space-y-1">
          <span className="block text-xs text-zinc-500">{t('output.tempo')}</span>
          <NumberField
            id={ids.tempo}
            value={output.tempo}
            min={0.5}
            max={2}
            step={0.05}
            disabled={!ffmpeg}
            onCommit={(tempo) => void change({ tempo })}
          />
        </label>
        <label htmlFor={ids.gain} className="space-y-1">
          <span className="block text-xs text-zinc-500">{t('output.gain')}</span>
          <NumberField
            id={ids.gain}
            value={output.gain_db}
            min={-20}
            max={20}
            step={0.5}
            disabled={!ffmpeg || output.loudness !== null}
            onCommit={(gain_db) => void change({ gain_db })}
          />
        </label>
      </div>
      <p className="pt-2 text-xs text-zinc-500">
        {ffmpeg ? t('output.hint') : t('output.needFfmpeg')}
      </p>
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </details>
  );
}
