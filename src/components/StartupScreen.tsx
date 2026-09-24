'use client';

import { useTranslation } from 'react-i18next';

import { useAppStore } from '@/store/app';

import { Spinner } from './icons';
import { Screen } from './Screen';

export function StartupScreen() {
  const { t } = useTranslation();
  const loadingModel = useAppStore((s) => s.status === 'loading_model');
  return (
    <Screen>
      <div className="flex items-center gap-3">
        <Spinner className="text-sky-500" />
        <p>{loadingModel ? t('home.loadingModel') : t('home.starting')}</p>
      </div>
    </Screen>
  );
}
