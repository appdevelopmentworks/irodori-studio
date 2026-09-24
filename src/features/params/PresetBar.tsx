'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { button, input, primaryButton } from '@/components/ui';
import { codeOf } from '@/lib/jobs';
import type { ParamSchema } from '@/lib/types';
import { usePresetStore } from '@/store/presets';
import { useSidecarStore } from '@/store/sidecar';

import { type ParamValues, requestParams, valuesFrom } from './schema';

/** Load a saved parameter preset into a panel, or save the panel's values as one. A
 * preset sets exactly its values; the others go back to their defaults. */
export function PresetBar({
  schema,
  values,
  onLoad,
}: {
  schema: ParamSchema[];
  values: ParamValues;
  onLoad: (values: ParamValues) => void;
}) {
  const { t } = useTranslation();
  const selectId = useId();
  const nameId = useId();
  const api = useSidecarStore((s) => s.api);
  const presets = usePresetStore((s) => s.presets);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (api) void usePresetStore.getState().load();
  }, [api]);

  if (!api) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const preset = await api.createPreset({
        name: name.trim(),
        params: requestParams(schema, values),
      });
      await usePresetStore.getState().load();
      setSaved(preset.name);
      setNaming(false);
      setName('');
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={selectId} className="text-zinc-500">
          {t('library.presetBar.label')}
        </label>
        <select
          id={selectId}
          value=""
          disabled={!presets || presets.length === 0}
          onChange={(event) => {
            const preset = presets?.find((p) => p.id === event.target.value);
            if (!preset) return;
            onLoad(valuesFrom(preset.params, schema));
            setSaved(null);
          }}
          className="max-w-64 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">
            {presets && presets.length > 0 ? t('library.presetBar.load') : t('library.presetBar.none')}
          </option>
          {(presets ?? []).map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        {!naming ? (
          <button type="button" onClick={() => setNaming(true)} className={button}>
            {t('library.presetBar.saveAs')}
          </button>
        ) : null}
        {saved ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-400">
            {t('library.presetBar.saved', { name: saved })}
          </span>
        ) : null}
      </div>
      {naming ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={nameId} className="sr-only">
            {t('library.presetBar.name')}
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={60}
            placeholder={t('library.presetBar.name')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name.trim()) void save();
            }}
            className={`${input} max-w-64`}
          />
          <button
            type="button"
            disabled={saving || !name.trim()}
            onClick={() => void save()}
            className={`${primaryButton} px-3 py-1.5`}
          >
            {t('library.presetBar.save')}
          </button>
          <button type="button" onClick={() => setNaming(false)} className={button}>
            {t('library.common.cancel')}
          </button>
        </div>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </div>
  );
}
