// UI locales (D17). `ja` is the source locale: keys are added there first and
// mirrored into every other locale in the same change (scripts/check-i18n.mjs).
export const SUPPORTED_LOCALES = ['ja', 'en', 'zh-Hans', 'de'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const SOURCE_LOCALE: Locale = 'ja';

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
