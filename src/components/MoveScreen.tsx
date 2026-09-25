'use client';

import { useTranslation } from 'react-i18next';

import { formatBytes, formatPercent } from '@/lib/format';
import { cancelDataMove } from '@/lib/tauri';
import { useAppStore } from '@/store/app';

import { Spinner } from './icons';
import { ProgressBar } from './ProgressBar';
import { Screen } from './Screen';
import { button } from './ui';

/** While the data root moves (D16): the app is stopped, the copy's progress shows. */
export function MoveScreen() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const move = useAppStore((s) => s.move);
  const phase = move?.phase ?? 'stopping';
  const cancellable = phase === 'scanning' || phase === 'copying';

  return (
    <Screen wide>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Spinner className="text-sky-500" />
          <h1 className="text-xl font-semibold">{t('settings.move.screenTitle')}</h1>
        </div>
        {move?.from && move.to ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-zinc-500">{t('settings.move.from')}</dt>
            <dd className="font-mono text-xs break-all">{move.from}</dd>
            <dt className="text-zinc-500">{t('settings.move.to')}</dt>
            <dd className="font-mono text-xs break-all">{move.to}</dd>
          </dl>
        ) : null}
        <div className="space-y-2" aria-live="polite">
          <p className="text-sm font-medium">{t(`settings.move.phases.${phase}`)}</p>
          {move && move.total_bytes > 0 ? (
            <>
              <ProgressBar done={move.done_bytes} total={move.total_bytes} />
              <p className="text-xs text-zinc-500 tabular-nums">
                {t('settings.move.bytes', {
                  done: formatBytes(move.done_bytes, locale),
                  total: formatBytes(move.total_bytes, locale),
                  percent: formatPercent(move.done_bytes, move.total_bytes, locale),
                  files: move.done_files,
                  totalFiles: move.total_files,
                })}
              </p>
            </>
          ) : null}
        </div>
        <p className="text-xs text-zinc-500">{t('settings.move.keepOpen')}</p>
        {cancellable ? (
          <button type="button" onClick={() => void cancelDataMove()} className={button}>
            {t('settings.move.cancel')}
          </button>
        ) : null}
      </div>
    </Screen>
  );
}
