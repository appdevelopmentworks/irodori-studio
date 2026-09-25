'use client';

import { useTranslation } from 'react-i18next';

const ETHICS = ['impersonation', 'misinformation', 'resemblance', 'liability'] as const;

/** The first-run terms, including upstream's ethical restrictions (D13): accepted in the
 * setup wizard, shown again in Settings. */
export function TermsText() {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 text-sm leading-relaxed">
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
  );
}
