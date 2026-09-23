'use client';

import { useEffect, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import { setWindowTitle } from '@/lib/tauri';

import i18n from '.';

/**
 * Provides the i18next instance and keeps locale-dependent document state in sync:
 * `<html lang>` (so CJK text renders with the right glyphs), the document title, and
 * the native window title — which is not React-rendered, so it cannot follow `t()`
 * on its own.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const apply = (lng: string) => {
      document.documentElement.lang = lng;
      const title = i18n.t('common.appName');
      document.title = title;
      setWindowTitle(title).catch((err: unknown) => {
        console.error('setWindowTitle failed', err);
      });
    };
    apply(i18n.language);
    i18n.on('languageChanged', apply);
    return () => {
      i18n.off('languageChanged', apply);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
