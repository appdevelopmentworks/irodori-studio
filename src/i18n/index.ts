// react-i18next initialization. Resources are bundled (static export, no backend),
// so init is synchronous and the prerendered HTML matches the first client render.
// The active locale starts at the source locale; Session 1 restores the saved
// locale from settings.json via Rust (no browser storage, D11).
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { SOURCE_LOCALE, SUPPORTED_LOCALES } from './config';
import { resources } from './resources';

// Guard against re-initialization when the module is re-evaluated by HMR.
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: SOURCE_LOCALE,
    fallbackLng: SOURCE_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    load: 'currentOnly',
    initAsync: false,
    // React escapes rendered text already.
    interpolation: { escapeValue: false },
    // An empty translation falls back to `ja` instead of rendering a blank string.
    returnEmptyString: false,
  });
}

export default i18n;
