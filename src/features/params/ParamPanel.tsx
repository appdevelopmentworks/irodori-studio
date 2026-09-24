'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ParamGroup, ParamSchema } from '@/lib/types';

import { ParamField } from './ParamField';
import { RuntimeGroup } from './RuntimeGroup';
import {
  GROUP_ORDER,
  currentValue,
  isVisible,
  type ParamName,
  type ParamValue,
  type ParamValues,
  type ReferenceKind,
} from './schema';

interface ParamPanelProps {
  /** The whole served schema (needed to evaluate `visible_when`). */
  schema: ParamSchema[];
  values: ParamValues;
  reference: ReferenceKind;
  onChange: (param: ParamSchema, value: ParamValue) => void;
  /** Must be stable (see ParamField). */
  onValidity: (name: ParamName, valid: boolean) => void;
  /** Custom widgets appended to a group (e.g. the LoRA picker in "advanced"). */
  extras?: Partial<Record<ParamGroup, ReactNode>>;
}

/** The advanced tier: every advanced parameter the model supports, by group. */
export function ParamPanel({
  schema,
  values,
  reference,
  onChange,
  onValidity,
  extras = {},
}: ParamPanelProps) {
  const { t } = useTranslation();
  const groups = GROUP_ORDER.map((group) => ({
    group,
    params: schema.filter(
      (param) =>
        param.group === group &&
        param.tier === 'advanced' &&
        isVisible(param, schema, values, reference),
    ),
  })).filter(({ group, params }) => params.length > 0 || extras[group]);

  return (
    <div className="space-y-2">
      {groups.map(({ group, params }) => (
        <details
          key={group}
          open={group === 'sampling'}
          className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        >
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium select-none">
            {t(`params.groups.${group}`)}
          </summary>
          <div className="grid gap-x-6 gap-y-4 px-4 pt-1 pb-4 md:grid-cols-2">
            {params.map((param) => (
              <ParamField
                key={param.name}
                param={param}
                value={currentValue(param, values)}
                onChange={(value) => onChange(param, value)}
                onValidity={onValidity}
              />
            ))}
            {extras[group]}
          </div>
        </details>
      ))}
      <RuntimeGroup />
    </div>
  );
}
