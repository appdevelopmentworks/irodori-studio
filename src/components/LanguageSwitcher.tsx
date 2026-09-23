'use client';

import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES, isLocale } from '@/i18n/config';
import { setLocale } from '@/lib/tauri';
import { useAppStore } from '@/store/app';

/**
 * Switches the UI language and saves the choice to settings.json through Rust (no
 * browser storage, D11). Each option shows the language's own name, taken from that
 * locale's resources.
 */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const patchBoot = useAppStore((s) => s.patchBoot);
  const selectId = useId();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor={selectId} className="text-sm text-zinc-600 dark:text-zinc-400">
        {t('common.language.label')}
      </label>
      <select
        id={selectId}
        value={i18n.resolvedLanguage}
        onChange={(event) => {
          const next = event.target.value;
          if (!isLocale(next)) return;
          void i18n.changeLanguage(next);
          patchBoot({ locale: next });
          setLocale(next).catch(() => undefined);
        }}
        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale} lang={locale}>
            {t('common.language.name', { lng: locale })}
          </option>
        ))}
      </select>
    </div>
  );
}
