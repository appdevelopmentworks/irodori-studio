'use client';

import { useTranslation } from 'react-i18next';

import { LanguageSwitcher } from '@/components/LanguageSwitcher';

// Session 0 placeholder. Session 3 replaces this with the app shell (sidebar
// navigation + active screen, docs/project-structure.md).
export default function HomePage() {
  const { t } = useTranslation();

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-6 rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('common.appName')}</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('common.tagline')}</p>
        </header>

        <section className="space-y-2">
          <h2 className="text-lg font-medium">{t('home.placeholder.title')}</h2>
          <p className="leading-relaxed text-zinc-700 dark:text-zinc-300">
            {t('home.placeholder.body')}
          </p>
        </section>

        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t('common.japaneseOnlyNotice')}
        </p>

        <LanguageSwitcher />
      </div>
    </main>
  );
}
