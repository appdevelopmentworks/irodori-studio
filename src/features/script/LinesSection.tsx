'use client';

import { Fragment, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EmojiPalette } from '@/components/EmojiPalette';
import { ErrorNotice } from '@/components/ErrorNotice';
import { PlusIcon, Spinner } from '@/components/icons';
import { ProgressBar } from '@/components/ProgressBar';
import { usePlayer } from '@/components/usePlayer';
import { button, primaryButton } from '@/components/ui';
import { isBusy } from '@/lib/jobs';
import type { ModelCapabilities } from '@/lib/types';
import { useScriptStore } from '@/store/script';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { cancelRender, render } from './actions';
import { AddLineRow, LineRow, type LineStatus } from './LineRow';

/** The lines as an editable table: speaker, text (emoji at the caret) and caption,
 * candidates, seed, pause and file name per line; render, listen, pick takes, reorder,
 * insert and delete. Edits are saved when a field is left. */
export function LinesSection({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const speakersListId = useId();
  const api = useSidecarStore((s) => s.api);
  const emoji = useSidecarStore((s) => s.emoji);
  const script = useScriptStore((s) => s.script);
  const job = useScriptStore((s) => s.job);
  const pauseMs = useScriptStore((s) => s.draft.pauseMs);
  const fileNames = useScriptStore((s) => s.fileNames);
  const invalid = useScriptStore((s) => Object.keys(s.invalid).length > 0);
  const voices = useVoicesStore((s) => s.voices);
  const [showEmoji, setShowEmoji] = useState(false);
  // Where the add-line form is: the position a new line gets.
  const [inserting, setInserting] = useState<number | null>(null);
  // Where an emoji goes: the text field focused last.
  const insertEmoji = useRef<((symbol: string) => void) | null>(null);
  const player = usePlayer(api ? api.audioUrl : null);

  if (!script || !api) return null;

  const busy = isBusy(job);
  const total = script.lines.length;
  const done = script.lines.filter((line) => line.adopted_audio_id).length;
  const limit = model.capabilities.max_output_seconds;
  const pending = new Set(busy && job ? job.pending : []);
  const current = busy && job?.phase === 'running' ? (job.pending[0] ?? null) : null;

  // What a line's caption falls back to: its speaker's caption, else the voice default.
  const captionHints = new Map<string, string | null>();
  for (const speaker of script.speakers) {
    const voice = voices?.find((v) => v.id === speaker.voice_id);
    captionHints.set(speaker.name, speaker.caption ?? voice?.caption_default ?? null);
  }

  let status: string | null = null;
  if (job?.phase === 'submitting') status = t('script.render.submitting');
  else if (job?.phase === 'queued') {
    status =
      job.position > 0
        ? t('script.render.queued', { position: job.position })
        : t('script.render.preparing');
  } else if (job?.phase === 'running') {
    status = job.lines
      ? t('script.render.running', { done: job.lines.done, total: job.lines.total })
      : t('script.render.preparing');
  }

  const statusOf = (lineId: string): LineStatus =>
    lineId === current ? 'rendering' : pending.has(lineId) ? 'waiting' : null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{t('script.lines.title')}</h2>
        <p className="text-xs text-zinc-500 tabular-nums">
          {t('script.lines.summary', { total, speakers: script.speakers.length, done })}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || done === total || invalid}
            onClick={() => void render(model.params)}
            className={primaryButton}
          >
            {done === 0 ? t('script.render.start') : t('script.render.resume')}
          </button>
          <button
            type="button"
            disabled={busy || done === 0 || invalid}
            onClick={() => void render(model.params, { redo: true })}
            className={button}
          >
            {t('script.render.redoAll')}
          </button>
          {busy ? (
            <button type="button" onClick={() => void cancelRender()} className={button}>
              {t('script.common.cancel')}
            </button>
          ) : null}
          {busy && status ? (
            <span className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <Spinner className="h-4 w-4 text-sky-500" />
              {status}
            </span>
          ) : null}
          {emoji && emoji.length > 0 ? (
            <button
              type="button"
              aria-expanded={showEmoji}
              onClick={() => setShowEmoji((show) => !show)}
              className={`${button} ml-auto`}
            >
              {showEmoji ? t('script.lines.hideEmoji') : t('script.lines.showEmoji')}
            </button>
          ) : null}
        </div>
        {busy && (job?.lines || job?.steps) ? (
          <div className="space-y-1">
            {job.lines ? <ProgressBar done={job.lines.done} total={job.lines.total} /> : null}
            {job.steps ? <ProgressBar done={job.steps.done} total={job.steps.total} thin /> : null}
          </div>
        ) : null}
        {job?.phase === 'completed' && job.result ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            {job.result.rendered > 0
              ? t('script.render.completed', { count: job.result.rendered })
              : t('script.render.nothing')}
          </p>
        ) : null}
        {job?.phase === 'cancelled' ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('script.render.cancelled')}</p>
        ) : null}
        {job?.phase === 'failed' && job.error ? (
          <ErrorNotice error={{ code: job.error.code, detail: job.error.message ?? null }} />
        ) : null}
      </div>

      {showEmoji && emoji ? (
        <div className="sticky top-0 z-10 space-y-1 rounded-lg border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <p className="px-1 text-xs text-zinc-500">{t('script.lines.emojiHint')}</p>
          <EmojiPalette items={emoji} onInsert={(symbol) => insertEmoji.current?.(symbol)} />
        </div>
      ) : null}

      {player.element}
      <datalist id={speakersListId}>
        {script.speakers.map((speaker) => (
          <option key={speaker.name} value={speaker.name} />
        ))}
      </datalist>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
            <tr>
              <th scope="col" className="w-12 px-2 py-2 text-right font-medium">
                {t('script.lines.index')}
              </th>
              <th scope="col" className="w-28 px-2 py-2 font-medium">
                {t('script.lines.speaker')}
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                {t('script.lines.text')}
              </th>
              <th scope="col" className="w-36 px-2 py-2 font-medium">
                {t('script.lines.options')}
              </th>
              <th scope="col" className="w-44 px-2 py-2 font-medium">
                {t('script.lines.audio')}
              </th>
              <th scope="col" className="w-20 px-2 py-2 font-medium">
                {t('script.lines.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {script.lines.map((line) => (
              <Fragment key={line.id}>
                <LineRow
                  scriptId={script.id}
                  line={line}
                  total={total}
                  model={model}
                  busy={busy}
                  status={statusOf(line.id)}
                  limit={limit}
                  speakersListId={speakersListId}
                  captionHint={captionHints.get(line.speaker) ?? null}
                  pausePlaceholder={pauseMs}
                  fileName={fileNames?.[line.index] ?? null}
                  playing={player.playing === line.adopted_audio_id}
                  onPlay={() => line.adopted_audio_id && player.toggle(line.adopted_audio_id)}
                  onFocusText={(insert) => {
                    insertEmoji.current = insert;
                  }}
                  onInsertBelow={() => setInserting(line.index + 1)}
                />
                {inserting === line.index + 1 ? (
                  <AddLineRow
                    scriptId={script.id}
                    position={line.index + 1}
                    speaker={line.speaker}
                    speakersListId={speakersListId}
                    onAdded={() => setInserting(line.index + 2)}
                    onClose={() => setInserting(null)}
                  />
                ) : null}
              </Fragment>
            ))}
            {total === 0 && inserting !== null ? (
              <AddLineRow
                scriptId={script.id}
                position={0}
                speaker={script.speakers[0]?.name ?? ''}
                speakersListId={speakersListId}
                onAdded={() => setInserting(1)}
                onClose={() => setInserting(null)}
              />
            ) : null}
          </tbody>
        </table>
      </div>
      {inserting === null ? (
        <button
          type="button"
          onClick={() => setInserting(total)}
          className={`${button} flex items-center gap-1.5`}
        >
          <PlusIcon className="h-4 w-4" />
          {t('script.lines.add')}
        </button>
      ) : null}
    </section>
  );
}
