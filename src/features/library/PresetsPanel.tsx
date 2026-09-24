'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { button, card, dangerButton, input } from '@/components/ui';
import type { ParamName, ParamValue } from '@/features/params/schema';
import { useParamText } from '@/features/params/text';
import { formatDateTime } from '@/lib/format';
import { codeOf } from '@/lib/jobs';
import type { ModelCapabilities, Preset } from '@/lib/types';
import { usePresetStore } from '@/store/presets';
import { useSidecarStore } from '@/store/sidecar';

/** The saved parameter presets: what each sets, rename, delete. New presets are saved
 * from the parameter panels. */
export function PresetsPanel({ model }: { model: ModelCapabilities }) {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const presets = usePresetStore((s) => s.presets);

  useEffect(() => {
    if (api) void usePresetStore.getState().load();
  }, [api]);

  if (!presets) return null;
  return (
    <section className="space-y-3">
      <p className="text-sm text-zinc-500">{t('library.presets.hint')}</p>
      {presets.length === 0 ? (
        <p className="text-sm text-zinc-500">{t('library.presets.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {presets.map((preset) => (
            <PresetRow key={`${preset.id}:${preset.name}`} preset={preset} model={model} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PresetRow({ preset, model }: { preset: Preset; model: ModelCapabilities }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const text = useParamText();
  const api = useSidecarStore((s) => s.api);
  const [name, setName] = useState(preset.name);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api) return null;

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await usePresetStore.getState().load();
    } catch (err) {
      setError(codeOf(err));
    }
  };
  const values = Object.entries(preset.params) as [ParamName, ParamValue][];

  return (
    <li className={`${card} space-y-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          maxLength={60}
          aria-label={t('library.presets.name')}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (!next) setName(preset.name);
            else if (next !== preset.name) void run(() => api.updatePreset(preset.id, { name: next }));
          }}
          className={`${input} max-w-72 font-medium`}
        />
        <span className="text-xs text-zinc-500">
          {t('library.presets.updated', { date: formatDateTime(preset.updated_at, locale) })}
        </span>
        <span className="ml-auto flex gap-2">
          {deleting ? (
            <>
              <button
                type="button"
                onClick={() => void run(() => api.deletePreset(preset.id))}
                className={dangerButton}
              >
                {t('library.presets.delete')}
              </button>
              <button type="button" onClick={() => setDeleting(false)} className={button}>
                {t('library.common.cancel')}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setDeleting(true)} className={button}>
              {t('library.presets.delete')}
            </button>
          )}
        </span>
      </div>
      {values.length === 0 ? (
        <p className="text-xs text-zinc-500">{t('library.presets.defaults')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {values.map(([key, value]) => {
            const param = model.params.find((p) => p.name === key);
            return (
              <li key={key} className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                {param
                  ? t('library.presets.value', {
                      name: text.label(key),
                      value: text.valueLabel(param, value),
                    })
                  : key}
              </li>
            );
          })}
        </ul>
      )}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </li>
  );
}
