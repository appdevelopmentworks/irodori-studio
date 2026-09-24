'use client';

import { useTranslation } from 'react-i18next';

import { CheckIcon, Spinner } from '@/components/icons';
import type { Voice } from '@/lib/types';
import type { EncodeStatus } from '@/store/voices';

/** Whether a voice's clips are encoded for the active model ("encode on save"): cached
 * reference latents let generations skip the encoder. */
export function EncodeBadge({
  voice,
  status,
  onEncode,
}: {
  voice: Voice;
  status: EncodeStatus | undefined;
  onEncode?: () => void;
}) {
  const { t } = useTranslation();
  if (voice.clips.length === 0) return null;

  if (status && status.phase !== 'failed') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-sky-700 dark:text-sky-300">
        <Spinner className="h-3.5 w-3.5" />
        {status.phase === 'queued' || status.total === 0
          ? t('voiceStudio.encode.queued')
          : t('voiceStudio.encode.running', { done: status.done, total: status.total })}
      </span>
    );
  }
  if (voice.encoded) {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckIcon className="h-3.5 w-3.5" />
        {t('voiceStudio.encode.done')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
      {status?.phase === 'failed' ? t('voiceStudio.encode.failed') : t('voiceStudio.encode.pending')}
      {onEncode ? (
        <button
          type="button"
          onClick={onEncode}
          className="rounded border border-amber-300 px-2 py-0.5 hover:bg-amber-50 dark:border-amber-800 dark:hover:bg-amber-950/40"
        >
          {t('voiceStudio.encode.now')}
        </button>
      ) : null}
    </span>
  );
}
