// Bundled translation resources. Each JSON file is a feature group and becomes the
// first segment of its keys: locales/ja/home.json { "starting" } is `t('home.starting')`.
// Register every new file for all four locales; scripts/check-i18n.mjs fails if a locale
// file is not registered here.
import type { Locale } from './config';
import deApiServer from './locales/de/apiServer.json';
import deCommon from './locales/de/common.json';
import deDictionary from './locales/de/dictionary.json';
import deEmoji from './locales/de/emoji.json';
import deErrors from './locales/de/errors.json';
import deHome from './locales/de/home.json';
import deLibrary from './locales/de/library.json';
import deNarration from './locales/de/narration.json';
import deOutput from './locales/de/output.json';
import deParams from './locales/de/params.json';
import deProjects from './locales/de/projects.json';
import deQuick from './locales/de/quick.json';
import deScript from './locales/de/script.json';
import deSettings from './locales/de/settings.json';
import deSetup from './locales/de/setup.json';
import deShell from './locales/de/shell.json';
import deVoiceStudio from './locales/de/voiceStudio.json';
import enApiServer from './locales/en/apiServer.json';
import enCommon from './locales/en/common.json';
import enDictionary from './locales/en/dictionary.json';
import enEmoji from './locales/en/emoji.json';
import enErrors from './locales/en/errors.json';
import enHome from './locales/en/home.json';
import enLibrary from './locales/en/library.json';
import enNarration from './locales/en/narration.json';
import enOutput from './locales/en/output.json';
import enParams from './locales/en/params.json';
import enProjects from './locales/en/projects.json';
import enQuick from './locales/en/quick.json';
import enScript from './locales/en/script.json';
import enSettings from './locales/en/settings.json';
import enSetup from './locales/en/setup.json';
import enShell from './locales/en/shell.json';
import enVoiceStudio from './locales/en/voiceStudio.json';
import jaApiServer from './locales/ja/apiServer.json';
import jaCommon from './locales/ja/common.json';
import jaDictionary from './locales/ja/dictionary.json';
import jaEmoji from './locales/ja/emoji.json';
import jaErrors from './locales/ja/errors.json';
import jaHome from './locales/ja/home.json';
import jaLibrary from './locales/ja/library.json';
import jaNarration from './locales/ja/narration.json';
import jaOutput from './locales/ja/output.json';
import jaParams from './locales/ja/params.json';
import jaProjects from './locales/ja/projects.json';
import jaQuick from './locales/ja/quick.json';
import jaScript from './locales/ja/script.json';
import jaSettings from './locales/ja/settings.json';
import jaSetup from './locales/ja/setup.json';
import jaShell from './locales/ja/shell.json';
import jaVoiceStudio from './locales/ja/voiceStudio.json';
import zhHansApiServer from './locales/zh-Hans/apiServer.json';
import zhHansCommon from './locales/zh-Hans/common.json';
import zhHansDictionary from './locales/zh-Hans/dictionary.json';
import zhHansEmoji from './locales/zh-Hans/emoji.json';
import zhHansErrors from './locales/zh-Hans/errors.json';
import zhHansHome from './locales/zh-Hans/home.json';
import zhHansLibrary from './locales/zh-Hans/library.json';
import zhHansNarration from './locales/zh-Hans/narration.json';
import zhHansOutput from './locales/zh-Hans/output.json';
import zhHansParams from './locales/zh-Hans/params.json';
import zhHansProjects from './locales/zh-Hans/projects.json';
import zhHansQuick from './locales/zh-Hans/quick.json';
import zhHansScript from './locales/zh-Hans/script.json';
import zhHansSettings from './locales/zh-Hans/settings.json';
import zhHansSetup from './locales/zh-Hans/setup.json';
import zhHansShell from './locales/zh-Hans/shell.json';
import zhHansVoiceStudio from './locales/zh-Hans/voiceStudio.json';

export const resources = {
  ja: {
    translation: {
      apiServer: jaApiServer,
      common: jaCommon,
      dictionary: jaDictionary,
      emoji: jaEmoji,
      errors: jaErrors,
      home: jaHome,
      library: jaLibrary,
      narration: jaNarration,
      output: jaOutput,
      params: jaParams,
      projects: jaProjects,
      quick: jaQuick,
      script: jaScript,
      settings: jaSettings,
      setup: jaSetup,
      shell: jaShell,
      voiceStudio: jaVoiceStudio,
    },
  },
  en: {
    translation: {
      apiServer: enApiServer,
      common: enCommon,
      dictionary: enDictionary,
      emoji: enEmoji,
      errors: enErrors,
      home: enHome,
      library: enLibrary,
      narration: enNarration,
      output: enOutput,
      params: enParams,
      projects: enProjects,
      quick: enQuick,
      script: enScript,
      settings: enSettings,
      setup: enSetup,
      shell: enShell,
      voiceStudio: enVoiceStudio,
    },
  },
  'zh-Hans': {
    translation: {
      apiServer: zhHansApiServer,
      common: zhHansCommon,
      dictionary: zhHansDictionary,
      emoji: zhHansEmoji,
      errors: zhHansErrors,
      home: zhHansHome,
      library: zhHansLibrary,
      narration: zhHansNarration,
      output: zhHansOutput,
      params: zhHansParams,
      projects: zhHansProjects,
      quick: zhHansQuick,
      script: zhHansScript,
      settings: zhHansSettings,
      setup: zhHansSetup,
      shell: zhHansShell,
      voiceStudio: zhHansVoiceStudio,
    },
  },
  de: {
    translation: {
      apiServer: deApiServer,
      common: deCommon,
      dictionary: deDictionary,
      emoji: deEmoji,
      errors: deErrors,
      home: deHome,
      library: deLibrary,
      narration: deNarration,
      output: deOutput,
      params: deParams,
      projects: deProjects,
      quick: deQuick,
      script: deScript,
      settings: deSettings,
      setup: deSetup,
      shell: deShell,
      voiceStudio: deVoiceStudio,
    },
  },
} as const satisfies Record<Locale, { translation: Record<string, unknown> }>;
