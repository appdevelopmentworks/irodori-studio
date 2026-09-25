'use client';

import { useTranslation } from 'react-i18next';

import { LogViewer } from '@/components/LogViewer';

import { Section } from './Section';

export function LogsTab() {
  const { t } = useTranslation();
  return (
    <Section title={t('settings.logs.title')} description={t('settings.logs.hint')}>
      <LogViewer />
    </Section>
  );
}
