'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice, type ErrorLike } from '@/components/ErrorNotice';
import { SOURCE_LOCALE, SUPPORTED_LOCALES, isLocale, type Locale } from '@/i18n/config';
import { errorCodeOf } from '@/lib/errors';
import { setLocale } from '@/lib/tauri';
import { useAppStore } from '@/store/app';

import { StepFooter } from './parts';

export function LanguageStep({ onNext }: { onNext: () => void }) {
  const { t, i18n } = useTranslation();
  const patchBoot = useAppStore((s) => s.patchBoot);
  const [choice, setChoice] = useState<Locale>(() => {
    const current = i18n.resolvedLanguage ?? '';
    return isLocale(current) ? current : SOURCE_LOCALE;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);

  const next = async () => {
    setBusy(true);
    try {
      await setLocale(choice);
      patchBoot({ locale: choice });
      onNext();
    } catch (err) {
      setError({ code: errorCodeOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t('setup.language.heading')}</h2>
      <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
        {SUPPORTED_LOCALES.map((locale) => (
          <label
            key={locale}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 ${
              choice === locale
                ? 'border-sky-600 bg-sky-50 dark:bg-sky-950/40'
                : 'border-zinc-200 hover:border-zinc-400 dark:border-zinc-700'
            }`}
          >
            <input
              type="radio"
              name="locale"
              value={locale}
              checked={choice === locale}
              onChange={() => {
                setChoice(locale);
                void i18n.changeLanguage(locale);
              }}
              className="accent-sky-600"
            />
            <span lang={locale}>{t('common.language.name', { lng: locale })}</span>
          </label>
        ))}
      </div>
      <p className="text-sm text-zinc-500">{t('setup.language.hint')}</p>
      <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        {t('common.japaneseOnlyNotice')}
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      <StepFooter onNext={() => void next()} busy={busy} />
    </div>
  );
}
