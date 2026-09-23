'use client';

import { useTranslation } from 'react-i18next';

import { Spinner } from './icons';
import { Screen } from './Screen';

export function StartupScreen() {
  const { t } = useTranslation();
  return (
    <Screen>
      <div className="flex items-center gap-3">
        <Spinner className="text-sky-500" />
        <p>{t('home.starting')}</p>
      </div>
    </Screen>
  );
}
