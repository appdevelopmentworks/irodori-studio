// Pure helpers over the served parameter schema (GET /models/active/capabilities).
// Components never list parameters themselves: which controls exist, their ranges,
// defaults, groups and visibility all come from the schema (D5, D26).
import type {
  ParamGroup,
  ParamSchema,
  ReferenceInput,
  SamplingParams,
  Voice,
} from '@/lib/types';

export type ParamName = keyof SamplingParams;
export type ParamValue = number | boolean | string | null;
/** Values the user changed; an absent key means "the schema default". */
export type ParamValues = Partial<Record<ParamName, ParamValue>>;
export type ReferenceKind = ReferenceInput['kind'];

export const GROUP_ORDER: ParamGroup[] = [
  'sampling',
  'duration',
  'cfg',
  'speaker',
  'reference',
  'advanced',
];

export function currentValue(param: ParamSchema, values: ParamValues): ParamValue {
  const value = values[param.name];
  return value === undefined ? param.default : value;
}

/** Evaluates `visible_when`: every listed key must currently hold one of its values. */
export function isVisible(
  param: ParamSchema,
  schema: ParamSchema[],
  values: ParamValues,
  reference: ReferenceKind,
): boolean {
  if (!param.visible_when) return true;
  return Object.entries(param.visible_when).every(([key, allowed]) => {
    if (key === 'reference') return allowed.includes(reference);
    const other = schema.find((p) => p.name === key);
    const value = other ? currentValue(other, values) : null;
    return value !== null && (allowed as ParamValue[]).includes(value);
  });
}

export type ParamIssue =
  | { reason: 'type' | 'integer' | 'required' }
  | { reason: 'below_minimum'; min: number }
  | { reason: 'above_maximum'; max: number };

/** Parses a numeric text field; blank means null for nullable parameters. */
export function parseNumber(
  param: ParamSchema,
  text: string,
): { value: number | null } | { issue: ParamIssue } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return param.nullable ? { value: null } : { issue: { reason: 'required' } };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { issue: { reason: 'type' } };
  if (param.type === 'int' && !Number.isInteger(value)) return { issue: { reason: 'integer' } };
  if (param.min !== null && value < param.min) {
    return { issue: { reason: 'below_minimum', min: param.min } };
  }
  if (param.max !== null && value > param.max) {
    return { issue: { reason: 'above_maximum', max: param.max } };
  }
  return { value };
}

/** Only the values that differ from the schema default go into the request. */
export function requestParams(schema: ParamSchema[], values: ParamValues): SamplingParams {
  const params: Record<string, ParamValue> = {};
  for (const param of schema) {
    const value = values[param.name];
    if (value !== undefined && value !== param.default) params[param.name] = value;
  }
  return params as SamplingParams;
}

/** Parameter values from a stored request or a voice's defaults: values equal to the
 * schema default are left out, like values the user never touched. */
export function valuesFrom(params: SamplingParams, schema: ParamSchema[]): ParamValues {
  const values: ParamValues = {};
  for (const param of schema) {
    const value = params[param.name];
    if (value !== undefined && value !== param.default) values[param.name] = value;
  }
  return values;
}

/** A voice's defaults as parameter values: `params_default` plus `seed_default`. */
export function voiceValues(voice: Voice, schema: ParamSchema[]): ParamValues {
  return valuesFrom({ ...voice.params_default, seed: voice.seed_default }, schema);
}
