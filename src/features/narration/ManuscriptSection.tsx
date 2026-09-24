'use client';

import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { button, card, input, primaryButton } from '@/components/ui';
import { codeOf } from '@/lib/jobs';
import { readTextFile } from '@/lib/textFile';
import type { ModelCapabilities, NarrationFormat } from '@/lib/types';
import { useNarrationStore } from '@/store/narration';

import { split } from './actions';

const FORMATS: NarrationFormat[] = ['text', 'markdown', 'srt'];
const SUBTITLE_TIMING = /^\s*(\d+:)?\d{1,2}:\d{2}[,.]\d{1,3}\s*-->/m;

function formatOf(name: string, text: string): NarrationFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith('.srt') || lower.endsWith('.vtt')) return 'srt';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  return SUBTITLE_TIMING.test(text) ? 'srt' : 'text';
}

/** The manuscript: pasted or read from .txt / .md / .srt / .vtt, and how to split it. */
export function ManuscriptSection({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const sourceId = useId();
  const minId = useId();
  const maxId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const source = useNarrationStore((s) => s.source);
  const format = useNarrationStore((s) => s.format);
  const rules = useNarrationStore((s) => s.rules);
  const narration = useNarrationStore((s) => s.narration);
  const rendering = useNarrationStore((s) => s.job !== null && s.job.finishedAt === null);
  const setSource = useNarrationStore((s) => s.setSource);
  const setFormat = useNarrationStore((s) => s.setFormat);
  const setRules = useNarrationStore((s) => s.setRules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const hasTakes = narration?.chunks.some((chunk) => chunk.takes.length > 0) ?? false;
  const unchanged =
    narration !== null &&
    narration.source === source &&
    narration.format === format &&
    narration.rules.min_chars === rules.min_chars &&
    narration.rules.max_chars === rules.max_chars;
  const rulesValid = rules.min_chars >= 1 && rules.max_chars >= 20 && rules.min_chars <= rules.max_chars;

  const run = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await split(model.params);
    } catch (err) {
      setError(codeOf(err));
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
      setError('internal');
    }
  };

  const number = (value: string, fallback: number) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return (
    <section className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <label htmlFor={sourceId} className="text-sm font-semibold">
          {t('narration.manuscript.title')}
        </label>
        <span className="text-xs text-zinc-500 tabular-nums">
          {t('narration.manuscript.chars', { total: source.length })}
        </span>
      </div>
      <textarea
        id={sourceId}
        lang="ja"
        rows={10}
        value={source}
        placeholder={t('narration.manuscript.placeholder')}
        onChange={(event) => setSource(event.target.value)}
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="flex flex-wrap items-end gap-4">
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.md,.markdown,.srt,.vtt,text/plain,text/markdown"
          hidden
          onChange={(event) => {
            void importFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <button type="button" onClick={() => fileInput.current?.click()} className={button}>
          {t('narration.manuscript.import')}
        </button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500">{t('narration.manuscript.format')}</span>
          <select
            value={format}
            onChange={(event) => setFormat(event.target.value as NarrationFormat)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {FORMATS.map((option) => (
              <option key={option} value={option}>
                {t(`narration.formats.${option}`)}
              </option>
            ))}
          </select>
        </label>
        {format !== 'srt' ? (
          <div className="flex items-end gap-2">
            <label htmlFor={minId} className="space-y-1 text-xs text-zinc-500">
              <span className="block">{t('narration.manuscript.minChars')}</span>
              <input
                id={minId}
                type="number"
                min={1}
                max={400}
                value={rules.min_chars}
                onChange={(event) =>
                  setRules({ ...rules, min_chars: number(event.target.value, rules.min_chars) })
                }
                className={`${input} w-24`}
              />
            </label>
            <label htmlFor={maxId} className="space-y-1 text-xs text-zinc-500">
              <span className="block">{t('narration.manuscript.maxChars')}</span>
              <input
                id={maxId}
                type="number"
                min={20}
                max={400}
                value={rules.max_chars}
                onChange={(event) =>
                  setRules({ ...rules, max_chars: number(event.target.value, rules.max_chars) })
                }
                className={`${input} w-24`}
              />
            </label>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-zinc-500">
        {format === 'srt'
          ? t('narration.manuscript.srtHint')
          : t('narration.manuscript.rulesHint', { seconds: model.capabilities.max_output_seconds })}
      </p>
      {!rulesValid ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t('narration.manuscript.rulesInvalid')}
        </p>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <span className="flex-1">{t('narration.manuscript.resplitConfirm')}</span>
          <button type="button" onClick={() => void run()} className={primaryButton}>
            {t('narration.manuscript.resplit')}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={button}>
            {t('narration.common.cancel')}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || rendering || !source.trim() || !rulesValid || unchanged}
            onClick={() => (hasTakes ? setConfirming(true) : void run())}
            className={primaryButton}
          >
            {narration ? t('narration.manuscript.resplit') : t('narration.manuscript.split')}
          </button>
          {busy ? <Spinner className="h-4 w-4 text-sky-500" /> : null}
        </div>
      )}
    </section>
  );
}
