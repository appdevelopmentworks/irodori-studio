'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Screen } from '@/components/Screen';
import type { BootState } from '@/lib/types';
import { useAppStore } from '@/store/app';

import { EnvironmentStep } from './EnvironmentStep';
import { InstallStep } from './InstallStep';
import { LanguageStep } from './LanguageStep';
import { Stepper, type WizardStep } from './parts';
import { StorageStep } from './StorageStep';
import { TermsStep } from './TermsStep';

/** First unfinished step. With language, terms and data root done, setup resumes. */
function firstStep(boot: BootState): WizardStep {
  if (boot.setup.running) return 'install';
  if (!boot.locale) return 'language';
  if (!boot.terms_accepted) return 'terms';
  if (!boot.data_root) return 'environment';
  return 'install';
}

/**
 * First-run wizard (requirements §6.2): language → terms (incl. upstream's ethical
 * restrictions) → probe result → data root → install + download. The smoke test
 * (generate and play a sentence) joins in Session 2.
 */
export function SetupWizard() {
  const { t } = useTranslation();
  const boot = useAppStore((s) => s.boot);
  const [step, setStep] = useState<WizardStep>(() => (boot ? firstStep(boot) : 'language'));
  // Opened straight on the install step at launch: an earlier setup was interrupted.
  const [resume] = useState(
    () => boot !== null && firstStep(boot) === 'install' && !boot.setup.running,
  );

  const afterTerms = (): WizardStep => (useAppStore.getState().boot?.data_root ? 'install' : 'environment');

  return (
    <Screen wide>
      <div className="space-y-6">
        <header className="space-y-3">
          <div>
            <p className="text-xs text-zinc-500">
              <span className="font-medium tracking-wide uppercase">{t('common.appName')}</span>
              {' · '}
              {t('common.tagline')}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">{t('setup.title')}</h1>
          </div>
          <Stepper current={step} />
        </header>

        {step === 'language' ? (
          <LanguageStep
            onNext={() =>
              setStep(useAppStore.getState().boot?.terms_accepted ? afterTerms() : 'terms')
            }
          />
        ) : null}
        {step === 'terms' ? (
          <TermsStep onBack={() => setStep('language')} onNext={() => setStep(afterTerms())} />
        ) : null}
        {step === 'environment' ? (
          <EnvironmentStep onBack={() => setStep('terms')} onNext={() => setStep('storage')} />
        ) : null}
        {step === 'storage' ? (
          <StorageStep onBack={() => setStep('environment')} onNext={() => setStep('install')} />
        ) : null}
        {step === 'install' ? (
          <InstallStep resume={resume} onBack={() => setStep('storage')} />
        ) : null}
      </div>
    </Screen>
  );
}
