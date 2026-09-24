'use client';

import { useTranslation } from 'react-i18next';

import { formatDateTime } from '@/lib/format';
import type { Consent, ConsentInput } from '@/lib/types';

/** Consent for a real person's voice (D13). The statement the user confirms is stored with
 * the voice word for word, in the language they read it in. */
export function ConsentBox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
      <p className="font-medium">{t('voiceStudio.consent.title')}</p>
      <p className="leading-relaxed">{t('voiceStudio.consent.statement')}</p>
      <label className="flex items-start gap-2 font-medium">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-1"
        />
        <span>{t('voiceStudio.consent.confirm')}</span>
      </label>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('voiceStudio.consent.note')}</p>
    </section>
  );
}

/** The consent record to send with a save: the statement exactly as shown. */
export function useConsentInput(): () => ConsentInput {
  const { t, i18n } = useTranslation();
  return () => ({
    statement: t('voiceStudio.consent.statement'),
    locale: i18n.resolvedLanguage ?? i18n.language,
  });
}

/** A stored consent record. */
export function ConsentRecord({ consent }: { consent: Consent }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  return (
    <details className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
      <summary className="cursor-pointer select-none">
        {t('voiceStudio.consent.recorded', {
          date: formatDateTime(consent.confirmed_at, locale),
        })}
      </summary>
      <blockquote lang={consent.locale} className="mt-2 border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
        {consent.statement}
      </blockquote>
    </details>
  );
}
