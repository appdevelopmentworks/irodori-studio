'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner, WarningIcon } from '@/components/icons';
import { ProgressBar } from '@/components/ProgressBar';
import { button, primaryButton, textarea } from '@/components/ui';
import { formatClock, formatSeconds } from '@/lib/format';
import { isBusy } from '@/lib/jobs';
import type { ModelCapabilities, Narration, NarrationChunk, ReadingResult } from '@/lib/types';
import { readingKey, useNarrationStore } from '@/store/narration';
import { useSidecarStore } from '@/store/sidecar';

import { cancelRender, edit, render } from './actions';

// Words the user dictionary replaced, in the reading preview.
const DICTIONARY_WORD = 'rounded bg-sky-100 px-0.5 dark:bg-sky-900/60';

const toKatakana = (text: string) =>
  text.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

const cueTime = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1).padStart(4, '0');
  return `${minutes}:${seconds}`;
};

/** Length of the assembled narration if every chunk takes its estimate. */
function estimatedTotal(narration: Narration, sentenceMs: number, paragraphMs: number): number {
  const chunks = narration.chunks;
  if (narration.format === 'srt') {
    const last = chunks[chunks.length - 1];
    return last?.cue ? last.cue.end_ms / 1000 : 0;
  }
  return chunks.reduce((sum, chunk, i) => {
    const seconds = chunk.takes.find((take) => take.audio_id === chunk.adopted_audio_id)?.duration_s;
    let pause = 0;
    if (i < chunks.length - 1) {
      if (chunk.pause_after === 'paragraph') pause = paragraphMs;
      else if (chunk.pause_after === 'clause') pause = sentenceMs / 2;
      else pause = sentenceMs;
    }
    return sum + (seconds ?? chunk.estimated_seconds) + pause / 1000;
  }, 0);
}

/** The chunks: render them (resume after a cancel), listen, pick takes, fix a chunk's
 * text and redo it, and check estimated readings. */
export function ChunkSection({ model }: { model: ModelCapabilities }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const api = useSidecarStore((s) => s.api);
  const narration = useNarrationStore((s) => s.narration);
  const job = useNarrationStore((s) => s.job);
  const draft = useNarrationStore((s) => s.draft);
  const invalid = useNarrationStore((s) => Object.keys(s.invalid).length > 0);
  const showReadings = useNarrationStore((s) => s.showReadings);
  const readings = useNarrationStore((s) => s.readings);

  // Fetch estimated readings for the chunks on demand (cached per text).
  const textsKey = JSON.stringify(narration?.chunks.map((chunk) => chunk.text) ?? []);
  useEffect(() => {
    if (!showReadings || !api) return;
    let active = true;
    void (async () => {
      for (const text of JSON.parse(textsKey) as string[]) {
        const key = readingKey(text, draft.applyDictionary);
        if (!active || useNarrationStore.getState().readings[key]) continue;
        try {
          const reading = await api.getReading(text, draft.applyDictionary);
          if (active) useNarrationStore.getState().setReading(key, reading);
        } catch {
          return;
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [showReadings, api, textsKey, draft.applyDictionary]);

  if (!narration || !api) return null;

  const busy = isBusy(job);
  const done = narration.chunks.filter((chunk) => chunk.adopted_audio_id).length;
  const total = narration.chunks.length;
  const limit = model.capabilities.max_output_seconds;
  const duration = estimatedTotal(narration, draft.pauses.sentence_ms, draft.pauses.paragraph_ms);

  let status: string | null = null;
  if (job?.phase === 'submitting') status = t('narration.render.submitting');
  else if (job?.phase === 'queued') {
    status =
      job.position > 0
        ? t('narration.render.queued', { position: job.position })
        : t('narration.render.preparing');
  } else if (job?.phase === 'running') {
    status = job.chunks
      ? t('narration.render.running', { done: job.chunks.done, total: job.chunks.total })
      : t('narration.render.preparing');
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{t('narration.chunks.title')}</h2>
        <p className="text-xs text-zinc-500 tabular-nums">
          {t('narration.chunks.summary', { total, duration: formatClock(duration), done })}
        </p>
      </div>

      {!narration.analyzer ? (
        <p className="text-xs text-zinc-500">{t('narration.chunks.analyzerMissing')}</p>
      ) : null}
      {narration.warnings.map((warning) => (
        <p
          key={`${warning.code}-${warning.index}`}
          className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <WarningIcon className="h-3.5 w-3.5" />
          {t(`narration.warnings.${warning.code}`, { index: warning.index + 1, limit })}
        </p>
      ))}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || done === total || invalid}
            onClick={() => void render(model.params)}
            className={primaryButton}
          >
            {done === 0 ? t('narration.render.start') : t('narration.render.resume')}
          </button>
          <button
            type="button"
            disabled={busy || done === 0 || invalid}
            onClick={() => void render(model.params, { redo: true })}
            className={button}
          >
            {t('narration.render.redoAll')}
          </button>
          {busy ? (
            <button type="button" onClick={() => void cancelRender()} className={button}>
              {t('narration.common.cancel')}
            </button>
          ) : null}
          {busy && status ? (
            <span className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <Spinner className="h-4 w-4 text-sky-500" />
              {status}
            </span>
          ) : null}
          <label className="ml-auto flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showReadings}
              onChange={(event) =>
                useNarrationStore.getState().setShowReadings(event.target.checked)
              }
            />
            {t('narration.chunks.showReadings')}
          </label>
        </div>
        {busy && (job?.chunks || job?.steps) ? (
          <div className="space-y-1">
            {job.chunks ? <ProgressBar done={job.chunks.done} total={job.chunks.total} /> : null}
            {job.steps ? <ProgressBar done={job.steps.done} total={job.steps.total} thin /> : null}
          </div>
        ) : null}
        {job?.phase === 'completed' && job.result ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            {job.result.rendered > 0
              ? t('narration.render.completed', { rendered: job.result.rendered })
              : t('narration.render.nothing')}
          </p>
        ) : null}
        {job?.phase === 'cancelled' ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('narration.render.cancelled')}</p>
        ) : null}
        {job?.phase === 'failed' && job.error ? (
          <ErrorNotice error={{ code: job.error.code, detail: job.error.message ?? null }} />
        ) : null}
        {showReadings ? (
          <p className="text-xs text-zinc-500">{t('narration.chunks.readingsHint')}</p>
        ) : null}
      </div>

      <ol className="space-y-2">
        {narration.chunks.map((chunk) => (
          <ChunkRow
            key={`${chunk.index}-${chunk.text}`}
            narrationId={narration.id}
            chunk={chunk}
            busy={busy}
            limit={limit}
            locale={locale}
            model={model}
            reading={
              showReadings ? readings[readingKey(chunk.text, draft.applyDictionary)] : undefined
            }
          />
        ))}
      </ol>
    </section>
  );
}

function ChunkRow({
  narrationId,
  chunk,
  busy,
  limit,
  locale,
  model,
  reading,
}: {
  narrationId: string;
  chunk: NarrationChunk;
  busy: boolean;
  limit: number;
  locale: string;
  model: ModelCapabilities;
  reading: ReadingResult | undefined;
}) {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(chunk.text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!api) return null;

  const adopted = chunk.takes.find((take) => take.audio_id === chunk.adopted_audio_id) ?? null;
  const takeNumber = chunk.takes.findIndex((take) => take.audio_id === chunk.adopted_audio_id);

  const run = async (action: () => Promise<string | null>) => {
    setSaving(true);
    setError(await action());
    setSaving(false);
  };

  return (
    <li className="space-y-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700 tabular-nums dark:text-zinc-300">
          {chunk.index + 1}
        </span>
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
          {t(`narration.pause.${chunk.pause_after}`)}
        </span>
        <span className="tabular-nums">
          {chunk.cue
            ? t('narration.chunk.cue', {
                start: cueTime(chunk.cue.start_ms),
                end: cueTime(chunk.cue.end_ms),
              })
            : t('narration.chunk.estimated', {
                seconds: formatSeconds(chunk.estimated_seconds, locale),
              })}
        </span>
        {adopted ? (
          <span className="text-emerald-700 tabular-nums dark:text-emerald-400">
            {t('narration.chunk.duration', { seconds: formatSeconds(adopted.duration_s, locale) })}
          </span>
        ) : (
          <span>{t('narration.chunk.pending')}</span>
        )}
        <span className="ml-auto flex gap-1">
          {!editing ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setText(chunk.text);
                setEditing(true);
              }}
              className="rounded px-2 py-0.5 text-sky-700 hover:bg-sky-50 disabled:opacity-40 dark:text-sky-400 dark:hover:bg-sky-950"
            >
              {t('narration.chunk.edit')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy || saving}
            onClick={() => void render(model.params, { indices: [chunk.index], redo: true })}
            className="rounded px-2 py-0.5 text-sky-700 hover:bg-sky-50 disabled:opacity-40 dark:text-sky-400 dark:hover:bg-sky-950"
          >
            {adopted ? t('narration.chunk.redo') : t('narration.chunk.render')}
          </button>
        </span>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            lang="ja"
            rows={3}
            maxLength={1000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className={textarea}
          />
          <p className="text-xs text-zinc-500">{t('narration.chunk.editHint')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={saving || !text.trim()}
              onClick={() =>
                void run(async () => {
                  const code = await edit(() =>
                    api.updateChunk(narrationId, chunk.index, { text: text.trim() }),
                  );
                  if (!code) setEditing(false);
                  return code;
                })
              }
              className={primaryButton}
            >
              {t('narration.chunk.saveText')}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={button}>
              {t('narration.common.cancel')}
            </button>
          </div>
        </div>
      ) : reading ? (
        <p lang="ja" className="leading-loose">
          {reading.tokens.map((token, i) => {
            const ruby = token.source !== 'symbol' && toKatakana(token.surface) !== token.reading;
            const tone = token.source === 'dictionary' ? DICTIONARY_WORD : undefined;
            return ruby ? (
              <ruby key={i} className={tone}>
                {token.surface}
                <rt className="text-[10px] text-zinc-500">{token.reading}</rt>
              </ruby>
            ) : (
              <span key={i} className={tone}>
                {token.surface}
              </span>
            );
          })}
        </p>
      ) : (
        <p lang="ja" className="leading-relaxed whitespace-pre-wrap">
          {chunk.text}
        </p>
      )}

      {adopted ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* Generated speech has no caption track. */}
          <audio
            controls
            preload="none"
            src={api.audioUrl(adopted.audio_id)}
            className="h-9 min-w-0 flex-1"
          />
          {chunk.takes.length > 1 ? (
            <select
              value={chunk.adopted_audio_id ?? ''}
              disabled={busy || saving}
              aria-label={t('narration.chunk.takes')}
              onChange={(event) =>
                void run(() =>
                  edit(() =>
                    api.updateChunk(narrationId, chunk.index, {
                      adopted_audio_id: event.target.value,
                    }),
                  ),
                )
              }
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {chunk.takes.map((take, i) => (
                <option key={take.audio_id} value={take.audio_id}>
                  {t('narration.chunk.take', {
                    index: i + 1,
                    seconds: formatSeconds(take.duration_s, locale),
                  })}
                </option>
              ))}
            </select>
          ) : null}
          {takeNumber >= 0 && adopted.truncated ? (
            <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
              <WarningIcon className="h-3.5 w-3.5" />
              {t('narration.chunk.truncated', { limit })}
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </li>
  );
}
