// Localized texts for parameters (`params.<name>.*` in locales/*/params.json). Labels and
// help exist for every parameter (type-checked); null labels and choice labels exist only
// where they apply, so those are looked up with a fallback to the raw value.
import { useTranslation } from 'react-i18next';

import type { ParamSchema } from '@/lib/types';

import type { ParamIssue, ParamName, ParamValue } from './schema';

export function useParamText() {
  const { t, i18n } = useTranslation();

  const optional = (key: string, fallback: string) =>
    // Keys built from schema data; `exists` guards the cast.
    i18n.exists(key) ? t(key as never) : fallback;

  const nullLabel = (name: ParamName) => optional(`params.${name}.null`, '');
  const choice = (name: ParamName, value: string) =>
    optional(`params.${name}.choices.${value}`, value);

  return {
    label: (name: ParamName) => t(`params.${name}.label`),
    help: (name: ParamName) => t(`params.${name}.help`),
    nullLabel,
    choice,
    /** Human-readable form of a value, for "default: …" hints. */
    valueLabel: (param: ParamSchema, value: ParamValue): string => {
      if (value === null) return nullLabel(param.name);
      if (typeof value === 'boolean') return value ? t('params.runtime.on') : t('params.runtime.off');
      if (typeof value === 'string') return choice(param.name, value);
      return new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, {
        maximumFractionDigits: 3,
      }).format(value);
    },
    issue: (issue: ParamIssue) => {
      switch (issue.reason) {
        case 'below_minimum':
          return t('params.errors.below_minimum', { min: issue.min });
        case 'above_maximum':
          return t('params.errors.above_maximum', { max: issue.max });
        default:
          return t(`params.errors.${issue.reason}`);
      }
    },
    /** Server-side reason codes (`invalid_params` detail.reason). */
    reason: (reason: string) => optional(`params.errors.${reason}`, reason),
  };
}
