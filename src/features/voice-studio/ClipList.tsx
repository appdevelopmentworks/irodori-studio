'use client';

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { CrossIcon } from '@/components/icons';
import { formatSeconds } from '@/lib/format';
import type { ClipInfo } from '@/lib/types';
import type { PendingClip } from '@/store/voices';

import { ClipEditor } from './ClipEditor';
import { Recorder, TARGET_SECONDS } from './Recorder';
import { button, iconButton } from './ui';

export interface ClipActions {
  move: (clipId: string, delta: -1 | 1) => void;
  remove: (clipId: string) => void;
  trim: (clipId: string, start: number, end: number) => void;
  split: (clipId: string, at: number) => void;
  dismissPending: (key: string) => void;
  addFiles: (files: File[]) => void;
  addRecording: (wav: Blob, seconds: number) => Promise<void>;
}

/** A voice's reference clips in order: listen, edit (trim / split), reorder, remove, and
 * add more from files or the microphone. */
export function ClipList({
  clips,
  pending,
  audioUrl,
  maxRefSeconds,
  maxClips,
  busy,
  recordOpen = false,
  canAdd = true,
  actions,
}: {
  clips: ClipInfo[];
  pending: PendingClip[];
  audioUrl: (clipId: string) => string;
  /** Reference audio beyond this is not used by the model. */
  maxRefSeconds: number;
  maxClips: number;
  /** An edit is in flight: clip controls are disabled. */
  busy: boolean;
  /** Show the recorder from the start (voices made by recording). */
  recordOpen?: boolean;
  /** New clips may be added (false until consent is confirmed where it is missing). */
  canAdd?: boolean;
  actions: ClipActions;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const fileInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [recording, setRecording] = useState(recordOpen);

  const total = clips.reduce((sum, clip) => sum + clip.duration_s, 0);
  const full = clips.length + pending.length >= maxClips;
  const addBlocked = busy || full || !canAdd;

  return (
    <div className="space-y-3">
      {clips.length > 0 ? (
        <ol className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          {clips.map((clip, index) => (
            <li key={clip.clip_id} className="space-y-2 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="w-5 text-right text-xs text-zinc-400 tabular-nums">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate" title={clip.filename}>
                  {clip.filename}
                </span>
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  {t(`voiceStudio.clips.origins.${clip.origin}`)}
                </span>
                <span className="text-xs text-zinc-500 tabular-nums">
                  {t('voiceStudio.clips.duration', { seconds: formatSeconds(clip.duration_s, locale) })}
                </span>
                <button
                  type="button"
                  aria-expanded={editing === clip.clip_id}
                  onClick={() => setEditing(editing === clip.clip_id ? null : clip.clip_id)}
                  className="rounded px-2 py-0.5 text-xs text-sky-700 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-950"
                >
                  {editing === clip.clip_id ? t('voiceStudio.clips.close') : t('voiceStudio.clips.edit')}
                </button>
                <button
                  type="button"
                  disabled={busy || index === 0}
                  onClick={() => actions.move(clip.clip_id, -1)}
                  aria-label={t('voiceStudio.clips.moveUp')}
                  title={t('voiceStudio.clips.moveUp')}
                  className={iconButton}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={busy || index === clips.length - 1}
                  onClick={() => actions.move(clip.clip_id, 1)}
                  aria-label={t('voiceStudio.clips.moveDown')}
                  title={t('voiceStudio.clips.moveDown')}
                  className={iconButton}
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(clip.clip_id)}
                  aria-label={t('voiceStudio.clips.remove')}
                  title={t('voiceStudio.clips.remove')}
                  className={iconButton}
                >
                  <CrossIcon className="h-4 w-4" />
                </button>
              </div>
              {confirming === clip.clip_id ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">
                  <span className="flex-1">{t('voiceStudio.clips.removeConfirm')}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      actions.remove(clip.clip_id);
                    }}
                    className="rounded-md bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-700"
                  >
                    {t('voiceStudio.clips.removeYes')}
                  </button>
                  <button type="button" onClick={() => setConfirming(null)} className={button}>
                    {t('voiceStudio.common.cancel')}
                  </button>
                </div>
              ) : null}
              {editing === clip.clip_id ? (
                <ClipEditor
                  key={clip.clip_id}
                  url={audioUrl(clip.clip_id)}
                  busy={busy}
                  onTrim={(start, end) => {
                    setEditing(null);
                    actions.trim(clip.clip_id, start, end);
                  }}
                  onSplit={(at) => {
                    setEditing(null);
                    actions.split(clip.clip_id, at);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-zinc-500">{t('voiceStudio.clips.empty')}</p>
      )}

      {pending.map((item) =>
        item.error ? (
          <div key={item.key} className="space-y-1">
            <p className="text-xs text-zinc-500">{item.filename}</p>
            <ErrorNotice error={{ code: item.error }} />
            <button type="button" onClick={() => actions.dismissPending(item.key)} className={button}>
              {t('voiceStudio.clips.dismiss')}
            </button>
          </div>
        ) : (
          <p key={item.key} className="text-xs text-zinc-500">
            {t('voiceStudio.clips.uploading', { name: item.filename })}
          </p>
        ),
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.wav,.flac,.ogg,.opus,.mp3,.m4a"
          multiple
          hidden
          onChange={(event) => {
            actions.addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={addBlocked}
          onClick={() => fileInput.current?.click()}
          className={button}
        >
          {t('voiceStudio.clips.addFiles')}
        </button>
        <button
          type="button"
          aria-expanded={recording}
          disabled={addBlocked && !recording}
          onClick={() => setRecording((open) => !open)}
          className={button}
        >
          {recording ? t('voiceStudio.clips.closeRecorder') : t('voiceStudio.clips.record')}
        </button>
        {clips.length > 0 ? (
          <span className="text-xs text-zinc-500 tabular-nums">
            {t('voiceStudio.clips.total', {
              seconds: formatSeconds(total, locale),
              max: formatSeconds(maxRefSeconds, locale, 0),
            })}
          </span>
        ) : null}
      </div>
      {total > maxRefSeconds ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t('voiceStudio.clips.over', { max: formatSeconds(maxRefSeconds, locale, 0) })}
        </p>
      ) : clips.length > 0 && total < TARGET_SECONDS ? (
        <p className="text-xs text-zinc-500">
          {t('voiceStudio.clips.short', { target: TARGET_SECONDS })}
        </p>
      ) : null}

      {recording ? (
        <Recorder collectedSeconds={total} disabled={addBlocked} onTake={actions.addRecording} />
      ) : null}
    </div>
  );
}
