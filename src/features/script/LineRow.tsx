'use client';

import { type Dispatch, type SetStateAction, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import {
  ChevronIcon,
  CrossIcon,
  PlayIcon,
  PlusIcon,
  Spinner,
  StopIcon,
  WarningIcon,
} from '@/components/icons';
import { button, iconButton, primaryButton } from '@/components/ui';
import { formatSeconds } from '@/lib/format';
import type { LinePatch, ModelCapabilities, ScriptLine } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';

import { edit, render } from './actions';

export type LineStatus = 'rendering' | 'waiting' | null;

const MAX_SEED = 2 ** 53 - 1;
const cell = 'px-2 py-2 align-top';
const field =
  'w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900';
const small =
  'w-full rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs tabular-nums dark:border-zinc-700 dark:bg-zinc-900';
const textButton =
  'rounded px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50 disabled:opacity-40 dark:text-sky-400 dark:hover:bg-sky-950';

/** Local text of a field, reset whenever the saved value changes. */
function useSynced(saved: string): [string, Dispatch<SetStateAction<string>>] {
  const [value, setValue] = useState(saved);
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setValue(saved);
  }
  return [value, setValue];
}

const numberText = (value: number | null) => (value === null ? '' : String(value));

/** A whole number in [min, max] from a field; `null` for blank, `undefined` if invalid. */
function parseCount(text: string, min: number, max: number): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

interface LineRowProps {
  scriptId: string;
  line: ScriptLine;
  total: number;
  model: ModelCapabilities;
  busy: boolean;
  status: LineStatus;
  limit: number;
  speakersListId: string;
  /** What the caption falls back to (the speaker's caption or the voice default). */
  captionHint: string | null;
  pausePlaceholder: number;
  /** The file name the naming template gives (without extension). */
  fileName: string | null;
  playing: boolean;
  onPlay: () => void;
  /** The text field got the focus: emoji from the palette go to `insert`. */
  onFocusText: (insert: (symbol: string) => void) => void;
  onInsertBelow: () => void;
}

/** One line of the script table. Fields save when left; new text or another speaker
 * discards the line's takes, so that asks first when there are takes. */
export function LineRow({
  scriptId,
  line,
  total,
  model,
  busy,
  status,
  limit,
  speakersListId,
  captionHint,
  pausePlaceholder,
  fileName,
  playing,
  onPlay,
  onFocusText,
  onInsertBelow,
}: LineRowProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const api = useSidecarStore((s) => s.api);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [speaker, setSpeaker] = useSynced(line.speaker);
  const [text, setText] = useSynced(line.text);
  const [caption, setCaption] = useSynced(line.caption ?? '');
  const [candidates, setCandidates] = useSynced(numberText(line.num_candidates));
  const [seed, setSeed] = useSynced(numberText(line.seed));
  const [pause, setPause] = useSynced(numberText(line.pause_ms));
  const [name, setName] = useSynced(line.file_name ?? '');
  const [confirm, setConfirm] = useState<LinePatch | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api) return null;

  const adopted = line.takes.find((take) => take.audio_id === line.adopted_audio_id) ?? null;
  const lineNumber = line.index + 1;

  const run = async (action: () => Promise<string | null>) => {
    setSaving(true);
    setError(await action());
    setSaving(false);
  };
  const patch = (body: LinePatch) =>
    run(() => edit(() => api.updateLine(scriptId, line.id, body)));

  const changeWords = (body: LinePatch) => {
    if (line.takes.length > 0) setConfirm((pending) => ({ ...pending, ...body }));
    else void patch(body);
  };

  const commitText = () => {
    const next = text.trim();
    if (!next) setText(line.text);
    else if (next !== line.text) changeWords({ text: next });
  };
  const commitSpeaker = () => {
    const next = speaker.trim();
    if (next !== line.speaker) changeWords({ speaker: next });
  };
  const commitOptional = (key: 'caption' | 'file_name', value: string) => {
    const next = value.trim() || null;
    if (next !== line[key]) void patch(key === 'caption' ? { caption: next } : { file_name: next });
  };
  const commitCount = (
    key: 'num_candidates' | 'seed' | 'pause_ms',
    value: string,
    reset: (text: string) => void,
    min: number,
    max: number,
  ) => {
    const next = parseCount(value, min, max);
    if (next === undefined) reset(numberText(line[key]));
    else if (next !== line[key]) void patch({ [key]: next } as LinePatch);
  };

  const insertEmoji = (symbol: string) => {
    const element = textRef.current;
    if (!element) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    setText((current) => current.slice(0, start) + symbol + current.slice(end));
    const caret = start + symbol.length;
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const tone =
    status === 'rendering'
      ? 'bg-sky-50/70 dark:bg-sky-950/30'
      : confirm || deleting
        ? 'bg-amber-50/60 dark:bg-amber-950/20'
        : '';

  return (
    <>
      <tr className={`border-t border-zinc-100 dark:border-zinc-800 ${tone}`}>
        <td className={`${cell} text-right text-xs text-zinc-500 tabular-nums`}>{lineNumber}</td>
        <td className={cell}>
          <input
            lang="ja"
            list={speakersListId}
            value={speaker}
            maxLength={32}
            aria-label={t('script.lines.speakerOf', { number: lineNumber })}
            onChange={(event) => setSpeaker(event.target.value)}
            onBlur={commitSpeaker}
            className={field}
          />
        </td>
        <td className={`${cell} space-y-1`}>
          <textarea
            ref={textRef}
            lang="ja"
            rows={2}
            maxLength={1000}
            value={text}
            aria-label={t('script.lines.textOf', { number: lineNumber })}
            onChange={(event) => setText(event.target.value)}
            onFocus={() => onFocusText(insertEmoji)}
            onBlur={commitText}
            className={`${field} resize-y leading-relaxed`}
          />
          {model.capabilities.caption ? (
            <input
              lang="ja"
              value={caption}
              maxLength={1000}
              aria-label={t('script.lines.captionOf', { number: lineNumber })}
              placeholder={
                captionHint
                  ? t('script.lines.captionInherited', { caption: captionHint })
                  : t('script.lines.captionPlaceholder')
              }
              onChange={(event) => setCaption(event.target.value)}
              onBlur={() => commitOptional('caption', caption)}
              className={`${small} text-left`}
            />
          ) : null}
        </td>
        <td className={cell}>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            <span>{t('script.lines.candidates')}</span>
            <input
              type="number"
              min={1}
              max={32}
              value={candidates}
              placeholder={t('script.lines.inherit')}
              aria-label={t('script.lines.candidatesOf', { number: lineNumber })}
              onChange={(event) => setCandidates(event.target.value)}
              onBlur={() => commitCount('num_candidates', candidates, setCandidates, 1, 32)}
              className={small}
            />
            <span>{t('script.lines.seed')}</span>
            <input
              type="number"
              min={0}
              value={seed}
              placeholder={t('script.lines.inherit')}
              aria-label={t('script.lines.seedOf', { number: lineNumber })}
              onChange={(event) => setSeed(event.target.value)}
              onBlur={() => commitCount('seed', seed, setSeed, 0, MAX_SEED)}
              className={small}
            />
            <span>{t('script.lines.pause')}</span>
            <input
              type="number"
              min={0}
              max={10000}
              step={50}
              value={pause}
              placeholder={String(pausePlaceholder)}
              aria-label={t('script.lines.pauseOf', { number: lineNumber })}
              onChange={(event) => setPause(event.target.value)}
              onBlur={() => commitCount('pause_ms', pause, setPause, 0, 10_000)}
              className={small}
            />
          </div>
        </td>
        <td className={`${cell} space-y-1`}>
          <div className="flex min-h-7 flex-wrap items-center gap-1.5 text-xs">
            {adopted ? (
              <>
                <button
                  type="button"
                  aria-label={
                    playing
                      ? t('script.lines.stopOf', { number: lineNumber })
                      : t('script.lines.playOf', { number: lineNumber })
                  }
                  title={playing ? t('script.lines.stop') : t('script.lines.play')}
                  onClick={onPlay}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-sky-600 text-white hover:bg-sky-700"
                >
                  {playing ? <StopIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                </button>
                <span className="text-emerald-700 tabular-nums dark:text-emerald-400">
                  {t('script.lines.duration', {
                    seconds: formatSeconds(adopted.duration_s, locale),
                  })}
                </span>
                {adopted.truncated ? (
                  <span
                    title={t('script.lines.truncated', { limit })}
                    className="text-amber-600 dark:text-amber-300"
                  >
                    <WarningIcon className="h-4 w-4" />
                    <span className="sr-only">{t('script.lines.truncated', { limit })}</span>
                  </span>
                ) : null}
              </>
            ) : status === 'rendering' ? (
              <span className="flex items-center gap-1.5 text-sky-700 dark:text-sky-400">
                <Spinner className="h-3.5 w-3.5" />
                {t('script.lines.rendering')}
              </span>
            ) : (
              <span className="text-zinc-500">
                {status === 'waiting' ? t('script.lines.waiting') : t('script.lines.pending')}
              </span>
            )}
          </div>
          {line.takes.length > 1 ? (
            <select
              value={line.adopted_audio_id ?? ''}
              disabled={saving}
              aria-label={t('script.lines.takesOf', { number: lineNumber })}
              onChange={(event) => void patch({ adopted_audio_id: event.target.value })}
              className={small}
            >
              {line.takes.map((take, i) => (
                <option key={take.audio_id} value={take.audio_id}>
                  {t('script.lines.take', {
                    index: i + 1,
                    seconds: formatSeconds(take.duration_s, locale),
                  })}
                </option>
              ))}
            </select>
          ) : null}
          <input
            value={name}
            maxLength={120}
            spellCheck={false}
            aria-label={t('script.lines.fileNameOf', { number: lineNumber })}
            placeholder={fileName ?? t('script.lines.fileName')}
            title={t('script.lines.fileNameHint')}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => commitOptional('file_name', name)}
            className={`${small} font-mono`}
          />
        </td>
        <td className={`${cell} space-y-1`}>
          <button
            type="button"
            disabled={busy || saving || confirm !== null}
            onClick={() => void render(model.params, { line_ids: [line.id], redo: true })}
            className={textButton}
          >
            {adopted ? t('script.lines.redo') : t('script.lines.render')}
          </button>
          <div className="grid w-fit grid-cols-2 gap-0.5">
            <button
              type="button"
              disabled={saving || line.index === 0}
              title={t('script.lines.moveUp')}
              aria-label={t('script.lines.moveUpOf', { number: lineNumber })}
              onClick={() =>
                void run(() => edit(() => api.moveLine(scriptId, line.id, line.index - 1)))
              }
              className={iconButton}
            >
              <ChevronIcon className="h-4 w-4 -rotate-90" />
            </button>
            <button
              type="button"
              disabled={saving || line.index === total - 1}
              title={t('script.lines.moveDown')}
              aria-label={t('script.lines.moveDownOf', { number: lineNumber })}
              onClick={() =>
                void run(() => edit(() => api.moveLine(scriptId, line.id, line.index + 1)))
              }
              className={iconButton}
            >
              <ChevronIcon className="h-4 w-4 rotate-90" />
            </button>
            <button
              type="button"
              title={t('script.lines.insertBelow')}
              aria-label={t('script.lines.insertBelowOf', { number: lineNumber })}
              onClick={onInsertBelow}
              className={iconButton}
            >
              <PlusIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={saving || status === 'rendering'}
              title={t('script.lines.delete')}
              aria-label={t('script.lines.deleteOf', { number: lineNumber })}
              onClick={() => setDeleting(true)}
              className={iconButton}
            >
              <CrossIcon className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
      {confirm || deleting || error ? (
        <tr className={tone}>
          <td />
          <td colSpan={5} className="px-2 pb-2">
            {confirm ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1">{t('script.lines.confirmChange')}</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    const body = confirm;
                    setConfirm(null);
                    void patch(body);
                  }}
                  className={button}
                >
                  {t('script.lines.applyChange')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirm(null);
                    setText(line.text);
                    setSpeaker(line.speaker);
                  }}
                  className={button}
                >
                  {t('script.lines.revert')}
                </button>
              </div>
            ) : null}
            {deleting ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1">
                  {line.takes.length > 0
                    ? t('script.lines.deleteConfirmTakes')
                    : t('script.lines.deleteConfirm')}
                </span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void run(async () => {
                      const code = await edit(() => api.deleteLine(scriptId, line.id));
                      if (!code) setDeleting(false);
                      return code;
                    })
                  }
                  className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
                >
                  {t('script.lines.delete')}
                </button>
                <button type="button" onClick={() => setDeleting(false)} className={button}>
                  {t('script.common.cancel')}
                </button>
              </div>
            ) : null}
            {error ? <ErrorNotice error={{ code: error }} /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** A form row for a new line at `position`; stays open for the next one. */
export function AddLineRow({
  scriptId,
  position,
  speaker: initialSpeaker,
  speakersListId,
  onAdded,
  onClose,
}: {
  scriptId: string;
  position: number;
  speaker: string;
  speakersListId: string;
  onAdded: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const [speaker, setSpeaker] = useState(initialSpeaker);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api) return null;

  const add = async () => {
    setSaving(true);
    const code = await edit(() =>
      api.insertLine(scriptId, {
        line: { speaker: speaker.trim(), text: text.trim() },
        position,
      }),
    );
    setSaving(false);
    setError(code);
    if (!code) {
      setText('');
      onAdded();
    }
  };

  return (
    <tr className="border-t border-zinc-100 bg-sky-50/50 dark:border-zinc-800 dark:bg-sky-950/20">
      <td className={`${cell} text-right text-zinc-400`}>
        <PlusIcon className="ml-auto h-4 w-4" />
      </td>
      <td className={cell}>
        <input
          lang="ja"
          list={speakersListId}
          value={speaker}
          maxLength={32}
          aria-label={t('script.lines.newSpeaker')}
          placeholder={t('script.lines.speaker')}
          onChange={(event) => setSpeaker(event.target.value)}
          className={field}
        />
      </td>
      <td colSpan={3} className={`${cell} space-y-2`}>
        <textarea
          lang="ja"
          rows={2}
          maxLength={1000}
          value={text}
          aria-label={t('script.lines.newText')}
          placeholder={t('script.lines.newTextPlaceholder')}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && text.trim()) {
              event.preventDefault();
              void add();
            }
          }}
          className={`${field} resize-y`}
        />
        {error ? <ErrorNotice error={{ code: error }} /> : null}
      </td>
      <td className={`${cell} space-y-1`}>
        <button
          type="button"
          disabled={saving || !text.trim()}
          onClick={() => void add()}
          className={`${primaryButton} w-full px-2 py-1`}
        >
          {t('script.lines.addSubmit')}
        </button>
        <button type="button" onClick={onClose} className={`${button} w-full px-2 py-1`}>
          {t('script.lines.addClose')}
        </button>
      </td>
    </tr>
  );
}
