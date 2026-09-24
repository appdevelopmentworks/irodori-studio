// Bundled translation resources. Each JSON file is a feature group and becomes the
// first segment of its keys: locales/ja/home.json { "starting" } is `t('home.starting')`.
// Register every new file for all four locales; scripts/check-i18n.mjs fails if a locale
// file is not registered here.
import type { Locale } from './config';
import deCommon from './locales/de/common.json';
import deEmoji from './locales/de/emoji.json';
import deErrors from './locales/de/errors.json';
import deHome from './locales/de/home.json';
import deParams from './locales/de/params.json';
import deQuick from './locales/de/quick.json';
import deSetup from './locales/de/setup.json';
import deShell from './locales/de/shell.json';
import deVoiceStudio from './locales/de/voiceStudio.json';
import enCommon from './locales/en/common.json';
import enEmoji from './locales/en/emoji.json';
import enErrors from './locales/en/errors.json';
import enHome from './locales/en/home.json';
import enParams from './locales/en/params.json';
import enQuick from './locales/en/quick.json';
import enSetup from './locales/en/setup.json';
import enShell from './locales/en/shell.json';
import enVoiceStudio from './locales/en/voiceStudio.json';
import jaCommon from './locales/ja/common.json';
import jaEmoji from './locales/ja/emoji.json';
import jaErrors from './locales/ja/errors.json';
import jaHome from './locales/ja/home.json';
import jaParams from './locales/ja/params.json';
import jaQuick from './locales/ja/quick.json';
import jaSetup from './locales/ja/setup.json';
import jaShell from './locales/ja/shell.json';
import jaVoiceStudio from './locales/ja/voiceStudio.json';
import zhHansCommon from './locales/zh-Hans/common.json';
import zhHansEmoji from './locales/zh-Hans/emoji.json';
import zhHansErrors from './locales/zh-Hans/errors.json';
import zhHansHome from './locales/zh-Hans/home.json';
import zhHansParams from './locales/zh-Hans/params.json';
import zhHansQuick from './locales/zh-Hans/quick.json';
import zhHansSetup from './locales/zh-Hans/setup.json';
import zhHansShell from './locales/zh-Hans/shell.json';
import zhHansVoiceStudio from './locales/zh-Hans/voiceStudio.json';

export const resources = {
  ja: {
    translation: {
      common: jaCommon,
      emoji: jaEmoji,
      errors: jaErrors,
      home: jaHome,
      params: jaParams,
      quick: jaQuick,
      setup: jaSetup,
      shell: jaShell,
      voiceStudio: jaVoiceStudio,
    },
  },
  en: {
    translation: {
      common: enCommon,
      emoji: enEmoji,
      errors: enErrors,
      home: enHome,
      params: enParams,
      quick: enQuick,
      setup: enSetup,
      shell: enShell,
      voiceStudio: enVoiceStudio,
    },
  },
  'zh-Hans': {
    translation: {
      common: zhHansCommon,
      emoji: zhHansEmoji,
      errors: zhHansErrors,
      home: zhHansHome,
      params: zhHansParams,
      quick: zhHansQuick,
      setup: zhHansSetup,
      shell: zhHansShell,
      voiceStudio: zhHansVoiceStudio,
    },
  },
  de: {
    translation: {
      common: deCommon,
      emoji: deEmoji,
      errors: deErrors,
      home: deHome,
      params: deParams,
      quick: deQuick,
      setup: deSetup,
      shell: deShell,
      voiceStudio: deVoiceStudio,
    },
  },
} as const satisfies Record<Locale, { translation: Record<string, unknown> }>;
