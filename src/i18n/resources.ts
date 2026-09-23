// Bundled translation resources. Each JSON file is a feature group and becomes the
// first segment of its keys: locales/ja/home.json { "placeholder": { "title" } }
// is `t('home.placeholder.title')`. Register every new file for all four locales;
// scripts/check-i18n.mjs fails if a locale file is not registered here.
import type { Locale } from './config';
import deCommon from './locales/de/common.json';
import deHome from './locales/de/home.json';
import enCommon from './locales/en/common.json';
import enHome from './locales/en/home.json';
import jaCommon from './locales/ja/common.json';
import jaHome from './locales/ja/home.json';
import zhHansCommon from './locales/zh-Hans/common.json';
import zhHansHome from './locales/zh-Hans/home.json';

export const resources = {
  ja: { translation: { common: jaCommon, home: jaHome } },
  en: { translation: { common: enCommon, home: enHome } },
  'zh-Hans': { translation: { common: zhHansCommon, home: zhHansHome } },
  de: { translation: { common: deCommon, home: deHome } },
} as const satisfies Record<Locale, { translation: Record<string, unknown> }>;
