// UI locales (D17). `ja` is the source locale: keys are added there first and
// mirrored into every other locale in the same change (scripts/check-i18n.mjs).
export const SUPPORTED_LOCALES = ['ja', 'en', 'zh-Hans', 'de'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const SOURCE_LOCALE: Locale = 'ja';

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Best supported locale for the OS preference list (first-run default). */
export function matchLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const language = tag.toLowerCase().split('-')[0];
    if (language === 'ja' || language === 'en' || language === 'de') return language;
    // Every Chinese variant falls back to Simplified Chinese, the one we ship (D17).
    if (language === 'zh') return 'zh-Hans';
  }
  return SOURCE_LOCALE;
}
