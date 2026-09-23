'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice, type ErrorLike } from '@/components/ErrorNotice';
import { errorCodeOf } from '@/lib/errors';
import { acceptTerms } from '@/lib/tauri';
import { useAppStore } from '@/store/app';

import { StepFooter } from './parts';

const ETHICS = ['impersonation', 'misinformation', 'resemblance', 'liability'] as const;

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
      <div className="max-h-80 space-y-3 overflow-y-auto rounded-lg border border-zinc-200 p-4 text-sm leading-relaxed dark:border-zinc-700">
        <p>{t('setup.terms.intro')}</p>
        <p>{t('setup.terms.unofficial')}</p>
        <div>
          <h3 className="font-semibold">{t('setup.terms.ethicsHeading')}</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {ETHICS.map((item) => (
              <li key={item}>{t(`setup.terms.ethics.${item}`)}</li>
            ))}
          </ul>
        </div>
        <p>{t('setup.terms.consent')}</p>
        <p>{t('setup.terms.watermark')}</p>
        <p>{t('setup.terms.privacy')}</p>
        <p>{t('setup.terms.license')}</p>
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
