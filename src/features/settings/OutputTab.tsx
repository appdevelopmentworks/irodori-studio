'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { LimitsPanel } from '@/features/library/LimitsPanel';
import { OutputSettings } from '@/features/output/OutputSettings';
import { useSidecarStore } from '@/store/sidecar';

import { Section } from './Section';

/** Generation and output defaults: the watermark (D12), export settings (D20) and the
 * history limits (D23), shared with the screens that use them. */
export function OutputTab() {
  const { t } = useTranslation();
  const preferences = useSidecarStore((s) => s.preferences);
  const updatePreferences = useSidecarStore((s) => s.updatePreferences);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {preferences ? (
        <Section title={t('settings.watermark.title')} description={t('settings.watermark.hint')}>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={preferences.watermark_enabled}
              onChange={(event) => {
                void updatePreferences({
                  watermark_enabled: event.target.checked,
                }).then(setError);
              }}
              className="h-4 w-4"
            />
            {t('settings.watermark.enabled')}
          </label>
          {!preferences.watermark_enabled ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {t('settings.watermark.offNote')}
            </p>
          ) : null}
          {error ? <ErrorNotice error={{ code: error }} /> : null}
        </Section>
      ) : null}
      <Section title={t('settings.output.title')} description={t('settings.output.hint')}>
        <OutputSettings />
      </Section>
      <LimitsPanel />
    </div>
  );
}
