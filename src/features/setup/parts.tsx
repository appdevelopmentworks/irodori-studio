'use client';

import { useTranslation } from 'react-i18next';

import { CheckIcon } from '@/components/icons';

export type WizardStep = 'language' | 'terms' | 'environment' | 'storage' | 'install';

export const WIZARD_STEPS: WizardStep[] = ['language', 'terms', 'environment', 'storage', 'install'];

export function Stepper({ current }: { current: WizardStep }) {
  const { t } = useTranslation();
  const currentIndex = WIZARD_STEPS.indexOf(current);
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {WIZARD_STEPS.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li
            key={step}
            aria-current={active ? 'step' : undefined}
            className={`flex items-center gap-1.5 ${
              active ? 'font-semibold text-sky-700 dark:text-sky-400' : 'text-zinc-500'
            }`}
          >
            {done ? (
              <CheckIcon className="h-4 w-4 text-emerald-600" />
            ) : (
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full border text-xs ${
                  active ? 'border-sky-600' : 'border-zinc-300 dark:border-zinc-700'
                }`}
              >
                {index + 1}
              </span>
            )}
            {t(`setup.steps.${step}`)}
          </li>
        );
      })}
    </ol>
  );
}

export function StepFooter({
  onBack,
  onNext,
  nextDisabled = false,
  busy = false,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextDisabled?: boolean;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between border-t border-zinc-200 pt-5 dark:border-zinc-800">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="rounded-md px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {t('common.actions.back')}
        </button>
      ) : (
        <span />
      )}
      {onNext ? (
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled || busy}
          className="rounded-md bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('common.actions.next')}
        </button>
      ) : null}
    </div>
  );
}
