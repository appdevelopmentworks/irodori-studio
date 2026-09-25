'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice, type ErrorLike } from '@/components/ErrorNotice';
import { TermsText } from '@/components/TermsText';
import { errorCodeOf } from '@/lib/errors';
import { acceptTerms } from '@/lib/tauri';
import { useAppStore } from '@/store/app';

import { StepFooter } from './parts';

/** First-run terms including upstream's ethical restrictions (D13). */
export function TermsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  const patchBoot = useAppStore((s) => s.patchBoot);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);

  const next = async () => {
    setBusy(true);
    try {
      await acceptTerms();
      patchBoot({ terms_accepted: true });
      onNext();
    } catch (err) {
      setError({ code: errorCodeOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t('setup.terms.heading')}</h2>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
        <TermsText />
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          className="h-4 w-4 accent-sky-600"
        />
        {t('setup.terms.agree')}
      </label>
      {error ? <ErrorNotice error={error} /> : null}
      <StepFooter onBack={onBack} onNext={() => void next()} nextDisabled={!agreed} busy={busy} />
    </div>
  );
}
