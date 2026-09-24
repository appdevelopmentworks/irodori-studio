'use client';

import { useTranslation } from 'react-i18next';

import { useSidecarStore } from '@/store/sidecar';

/** Runtime options of the resident model, read-only here: changing them reloads the model
 * (D4) and belongs to Settings (Session 9, D9). */
export function RuntimeGroup() {
  const { t } = useTranslation();
  const runtime = useSidecarStore((s) => s.engine?.runtime ?? null);
  if (!runtime) return null;

  const rows: [string, string][] = [
    [t('params.runtime.device'), t(`setup.environment.modes.${runtime.device}`)],
    [t('params.runtime.modelPrecision'), runtime.model_precision],
    [t('params.runtime.codecDevice'), t(`setup.environment.modes.${runtime.codec_device}`)],
    [t('params.runtime.codecPrecision'), runtime.codec_precision],
    [
      t('params.runtime.compile'),
      runtime.compile_model ? t('params.runtime.on') : t('params.runtime.off'),
    ],
  ];

  return (
    <details className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium select-none">
        {t('params.groups.runtime')}
      </summary>
      <div className="space-y-3 px-4 pt-1 pb-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-zinc-500">{label}</dt>
              <dd className="font-mono">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-zinc-500">{t('params.runtime.hint')}</p>
      </div>
    </details>
  );
}
