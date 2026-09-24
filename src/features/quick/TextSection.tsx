'use client';

import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { EmojiPalette } from '@/components/EmojiPalette';
import { useQuickStore } from '@/store/quick';
import { useSidecarStore } from '@/store/sidecar';

/** Text to speak + the emoji palette, which inserts at the caret. */
export function TextSection({ maxChars, onSubmit }: { maxChars: number; onSubmit: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = useQuickStore((s) => s.text);
  const setText = useQuickStore((s) => s.setText);
  const seedText = useQuickStore((s) => s.seedText);
  const emoji = useSidecarStore((s) => s.emoji);

  // Setup step 7: the first visit starts with a sample sentence, ready to generate.
  useEffect(() => seedText(t('quick.sampleText')), [seedText, t]);

  const insert = (symbol: string) => {
    const field = ref.current;
    const focused = field !== null && document.activeElement === field;
    const start = focused ? field.selectionStart : text.length;
    const end = focused ? field.selectionEnd : text.length;
    setText(text.slice(0, start) + symbol + text.slice(end));
    const caret = start + symbol.length;
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(caret, caret);
    });
  };

  const over = text.length > maxChars;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium">
          {t('quick.text.label')}
        </label>
        <span className={`text-xs tabular-nums ${over ? 'text-red-600' : 'text-zinc-500'}`}>
          {t('quick.text.count', { length: text.length, max: maxChars })}
        </span>
      </div>
      <textarea
        id={id}
        ref={ref}
        lang="ja"
        rows={5}
        value={text}
        placeholder={t('quick.text.placeholder')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
        className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base leading-relaxed dark:border-zinc-700 dark:bg-zinc-900"
      />
      <p className="text-xs text-zinc-500">
        {t('common.japaneseOnlyNotice')} {t('quick.text.shortcut')}
      </p>
      {emoji && emoji.length > 0 ? (
        <div className="space-y-1 rounded-lg border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="px-1 text-xs text-zinc-500">
            {t('quick.emoji.title')} — {t('quick.emoji.hint')}
          </p>
          <EmojiPalette items={emoji} onInsert={insert} />
        </div>
      ) : null}
    </section>
  );
}
