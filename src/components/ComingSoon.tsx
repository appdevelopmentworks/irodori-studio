'use client';

import { useTranslation } from 'react-i18next';

import type { ScreenId } from '@/store/nav';

/** Placeholder for screens that later sessions build. */
export function ComingSoon({ screen }: { screen: ScreenId }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-3xl space-y-2 p-6">
      <h1 className="text-xl font-semibold tracking-tight">{t(`shell.nav.${screen}`)}</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('shell.comingSoon.title')}</p>
      <p className="text-sm text-zinc-500">{t('shell.comingSoon.body')}</p>
    </div>
  );
}
