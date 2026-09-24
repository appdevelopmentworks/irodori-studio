'use client';

import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useQuickStore } from '@/store/quick';

import { STYLE_PRESETS } from './stylePresets';

/** Caption (voice design / style prompt) with emotion and style presets. */
export function CaptionSection({ maxChars }: { maxChars: number }) {
  const { t } = useTranslation();
  const id = useId();
  const caption = useQuickStore((s) => s.caption);
  const setCaption = useQuickStore((s) => s.setCaption);
  const withReference = useQuickStore((s) => s.reference !== 'none');

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {t('quick.caption.label')}
        </label>
        {caption ? (
          <button
            type="button"
            onClick={() => setCaption('')}
            className="text-xs text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
          >
            {t('quick.caption.clear')}
          </button>
        ) : null}
      </div>
      <textarea
        id={id}
        lang="ja"
        rows={2}
        maxLength={maxChars}
        value={caption}
        placeholder={t('quick.caption.placeholder')}
        onChange={(event) => setCaption(event.target.value)}
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-zinc-500">{t('quick.caption.presets')}</span>
        {STYLE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            title={preset.caption}
            aria-pressed={caption === preset.caption}
            onClick={() => setCaption(preset.caption)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              caption === preset.caption
                ? 'border-sky-600 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200'
                : 'border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
            }`}
          >
            {t(`quick.stylePresets.${preset.id}`)}
          </button>
        ))}
      </div>
      {withReference ? (
        <p className="text-xs text-zinc-500">{t('quick.caption.conflictHint')}</p>
      ) : null}
    </section>
  );
}
