'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ParamSchema } from '@/lib/types';

import { type ParamIssue, type ParamName, type ParamValue, parseNumber } from './schema';
import { useParamText } from './text';

interface ParamFieldProps {
  param: ParamSchema;
  value: ParamValue;
  onChange: (value: ParamValue) => void;
  /** Reports whether the field holds a usable value. Must be a stable function: it is an
   * effect dependency. */
  onValidity: (name: ParamName, valid: boolean) => void;
}

/** One control rendered from the schema: checkbox, select, slider + number, or number. */
export function ParamField({ param, value, onChange, onValidity }: ParamFieldProps) {
  const { t } = useTranslation();
  const text = useParamText();
  const id = useId();
  const changed = value !== param.default;
  const defaultLabel =
    param.default === null ? text.nullLabel(param.name) : text.valueLabel(param, param.default);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">
          {text.label(param.name)}
        </label>
        {changed ? (
          <button
            type="button"
            onClick={() => onChange(param.default)}
            title={t('params.defaultValue', { value: defaultLabel })}
            className="shrink-0 text-xs text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
          >
            {t('params.reset')}
          </button>
        ) : null}
      </div>
      {param.type === 'bool' ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            className="h-4 w-4 accent-sky-600"
          />
          <span className="text-zinc-600 dark:text-zinc-400">{text.help(param.name)}</span>
        </label>
      ) : param.type === 'enum' ? (
        <>
          <select
            id={id}
            value={String(value)}
            onChange={(event) => onChange(event.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {(param.choices ?? []).map((choice) => (
              <option key={choice} value={choice}>
                {text.choice(param.name, choice)}
              </option>
            ))}
          </select>
          <p className="text-xs text-zinc-500">{text.help(param.name)}</p>
        </>
      ) : (
        <NumberField
          id={id}
          param={param}
          value={value as number | null}
          onChange={onChange}
          onValidity={onValidity}
        />
      )}
    </div>
  );
}

interface NumberFieldProps {
  id: string;
  param: ParamSchema;
  value: number | null;
  onChange: (value: number | null) => void;
  onValidity: (name: ParamName, valid: boolean) => void;
}

const formatNumber = (value: number | null) => (value === null ? '' : String(value));

function NumberField({ id, param, value, onChange, onValidity }: NumberFieldProps) {
  const text = useParamText();
  const [draft, setDraft] = useState(formatNumber(value));
  const [issue, setIssue] = useState<ParamIssue | null>(null);
  // Follow outside changes (reset, "use this seed") without clobbering what is typed.
  const [shown, setShown] = useState(value);
  if (!Object.is(value, shown)) {
    setShown(value);
    const parsed = parseNumber(param, draft);
    if (!('value' in parsed) || parsed.value !== value) {
      setDraft(formatNumber(value));
      setIssue(null);
    }
  }

  const name = param.name;
  useEffect(() => onValidity(name, issue === null), [name, issue, onValidity]);
  // A hidden or collapsed field no longer blocks generation.
  useEffect(() => () => onValidity(name, true), [name, onValidity]);

  const commit = (next: string) => {
    setDraft(next);
    const parsed = parseNumber(param, next);
    if ('issue' in parsed) {
      setIssue(parsed.issue);
      return;
    }
    setIssue(null);
    onChange(parsed.value);
  };

  const slider = !param.nullable && param.min !== null && param.max !== null;
  const inputClass = `rounded-md border bg-white px-2 py-1.5 text-sm tabular-nums dark:bg-zinc-900 ${
    issue ? 'border-red-500' : 'border-zinc-300 dark:border-zinc-700'
  }`;

  return (
    <>
      <div className="flex items-center gap-3">
        {slider ? (
          <input
            type="range"
            aria-labelledby={`${id}-label`}
            min={param.min ?? undefined}
            max={param.max ?? undefined}
            step={param.step ?? 'any'}
            value={value ?? param.min ?? 0}
            onChange={(event) => commit(event.target.value)}
            className="min-w-0 flex-1 accent-sky-600"
          />
        ) : null}
        <input
          id={id}
          type="text"
          inputMode={param.type === 'int' ? 'numeric' : 'decimal'}
          value={draft}
          placeholder={param.nullable ? text.nullLabel(param.name) : undefined}
          onChange={(event) => commit(event.target.value)}
          aria-invalid={issue !== null}
          className={`${inputClass} ${slider ? 'w-24' : 'w-full'}`}
        />
      </div>
      {issue ? (
        <p className="text-xs text-red-600 dark:text-red-400">{text.issue(issue)}</p>
      ) : (
        <p className="text-xs text-zinc-500">{text.help(param.name)}</p>
      )}
    </>
  );
}
