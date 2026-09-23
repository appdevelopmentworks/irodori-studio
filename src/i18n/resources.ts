// Bundled translation resources. Each JSON file is a feature group and becomes the
// first segment of its keys: locales/ja/home.json { "ready": { "heading" } } is
// `t('home.ready.heading')`. Register every new file for all four locales;
// scripts/check-i18n.mjs fails if a locale file is not registered here.
import type { Locale } from './config';
import deCommon from './locales/de/common.json';
import deErrors from './locales/de/errors.json';
import deHome from './locales/de/home.json';
import deSetup from './locales/de/setup.json';
import enCommon from './locales/en/common.json';
import enErrors from './locales/en/errors.json';
import enHome from './locales/en/home.json';
import enSetup from './locales/en/setup.json';
import jaCommon from './locales/ja/common.json';
import jaErrors from './locales/ja/errors.json';
import jaHome from './locales/ja/home.json';
import jaSetup from './locales/ja/setup.json';
import zhHansCommon from './locales/zh-Hans/common.json';
import zhHansErrors from './locales/zh-Hans/errors.json';
import zhHansHome from './locales/zh-Hans/home.json';
import zhHansSetup from './locales/zh-Hans/setup.json';

export const resources = {
  ja: { translation: { common: jaCommon, errors: jaErrors, home: jaHome, setup: jaSetup } },
  en: { translation: { common: enCommon, errors: enErrors, home: enHome, setup: enSetup } },
  'zh-Hans': {
    translation: {
      common: zhHansCommon,
      errors: zhHansErrors,
      home: zhHansHome,
      setup: zhHansSetup,
    },
  },
  de: { translation: { common: deCommon, errors: deErrors, home: deHome, setup: deSetup } },
} as const satisfies Record<Locale, { translation: Record<string, unknown> }>;
