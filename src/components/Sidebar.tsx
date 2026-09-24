'use client';

import { useTranslation } from 'react-i18next';

import { SCREENS, useNavStore } from '@/store/nav';

import { LanguageSwitcher } from './LanguageSwitcher';

/** Navigation for the seven screens (requirements §6.1). */
export function Sidebar() {
  const { t } = useTranslation();
  const screen = useNavStore((s) => s.screen);
  const setScreen = useNavStore((s) => s.setScreen);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="px-4 pt-5 pb-4">
        <p className="text-base font-semibold tracking-tight">{t('common.appName')}</p>
        <p className="mt-0.5 text-xs text-zinc-500">{t('common.tagline')}</p>
      </div>
      <nav aria-label={t('shell.nav.label')} className="flex-1 space-y-0.5 px-2">
        {SCREENS.map((id) => (
          <button
            key={id}
            type="button"
            aria-current={screen === id ? 'page' : undefined}
            onClick={() => setScreen(id)}
            className={`block w-full rounded-md px-3 py-2 text-left text-sm ${
              screen === id
                ? 'bg-sky-50 font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-200'
                : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            {t(`shell.nav.${id}`)}
          </button>
        ))}
      </nav>
      <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
        <LanguageSwitcher />
      </div>
    </aside>
  );
}
