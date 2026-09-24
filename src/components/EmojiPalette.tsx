'use client';

import { useTranslation } from 'react-i18next';

import type { EmojiItem } from '@/lib/types';

/** Localized label/description of an emoji; unknown keys (a newer upstream palette) fall
 * back to upstream's Japanese text. */
export function useEmojiText() {
  const { t, i18n } = useTranslation();
  return (item: EmojiItem, part: 'label' | 'description') =>
    // Keys come from the API; `exists` guards the cast.
    i18n.exists(`emoji.${item.key}.${part}`)
      ? t(`emoji.${item.key}.${part}` as never)
      : part === 'label'
        ? item.label_ja
        : item.description_ja;
}

/** Upstream's emoji palette (GET /emoji). Buttons keep the focus in the text field, so an
 * emoji lands at the caret. */
export function EmojiPalette({
  items,
  onInsert,
}: {
  items: EmojiItem[];
  onInsert: (symbol: string) => void;
}) {
  const { t } = useTranslation();
  const text = useEmojiText();

  return (
    <div role="group" aria-label={t('quick.emoji.title')} className="flex flex-wrap gap-0.5">
      {items.map((item) => {
        const tooltip = t('quick.emoji.tooltip', {
          label: text(item, 'label'),
          description: text(item, 'description'),
        });
        return (
          <button
            key={item.key}
            type="button"
            title={tooltip}
            aria-label={tooltip}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onInsert(item.symbol)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-base leading-none hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-500 dark:hover:bg-zinc-800"
          >
            {item.symbol}
          </button>
        );
      })}
    </div>
  );
}
