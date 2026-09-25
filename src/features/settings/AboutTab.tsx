'use client';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { TermsText } from '@/components/TermsText';
import { formatDateTime } from '@/lib/format';
import { useSettingsStore } from '@/store/settings';
import { useSidecarStore } from '@/store/sidecar';

import { COMPONENTS } from './components';
import { Section } from './Section';

/** Version, licenses (the app, its models and components, the Python runtime) and the
 * accepted terms. */
export function AboutTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const api = useSidecarStore((s) => s.api);
  const info = useSettingsStore((s) => s.info);
  const licenses = useSettingsStore((s) => s.licenses);

  useEffect(() => {
    if (api) void useSettingsStore.getState().loadLicenses();
  }, [api]);

  const acceptedAt = info?.terms_accepted_at
    ? new Date(info.terms_accepted_at * 1000).toISOString()
    : null;

  return (
    <div className="space-y-6">
      <Section title={t('common.appName')} description={t('common.tagline')}>
        {info ? (
          <p className="text-sm">{t('settings.about.version', { version: info.app_version })}</p>
        ) : null}
        <p className="text-sm">{t('settings.about.license')}</p>
      </Section>

      <Section
        title={t('settings.about.components')}
        description={t('settings.about.componentsHint')}
      >
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1 pr-3 font-medium">{t('settings.about.name')}</th>
              <th className="py-1 pr-3 font-medium">{t('settings.about.role')}</th>
              <th className="py-1 font-medium">{t('settings.about.licenseColumn')}</th>
            </tr>
          </thead>
          <tbody>
            {COMPONENTS.map((component) => (
              <tr key={component.name} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-3">{component.name}</td>
                <td className="py-1 pr-3 text-zinc-600 dark:text-zinc-400">
                  {t(`settings.about.roles.${component.role}`)}
                </td>
                <td className="py-1 font-mono text-xs">{component.license}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={t('settings.about.python')} description={t('settings.about.pythonHint')}>
        {licenses ? (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-white text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t('settings.about.name')}</th>
                  <th className="py-1 pr-3 font-medium">{t('settings.about.versionColumn')}</th>
                  <th className="py-1 font-medium">{t('settings.about.licenseColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {licenses.map((row) => (
                  <tr key={row.name} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-1 pr-3">{row.name}</td>
                    <td className="py-1 pr-3 font-mono">{row.version}</td>
                    <td className="py-1">
                      {row.license ?? (
                        <span className="text-zinc-500">{t('settings.about.unknown')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">{t('settings.about.loading')}</p>
        )}
      </Section>

      <Section title={t('settings.about.terms')}>
        {acceptedAt ? (
          <p className="text-xs text-zinc-500">
            {t('settings.about.acceptedAt', {
              date: formatDateTime(acceptedAt, locale),
            })}
          </p>
        ) : null}
        <details>
          <summary className="cursor-pointer text-sm text-zinc-600 select-none dark:text-zinc-400">
            {t('settings.about.showTerms')}
          </summary>
          <div className="pt-3">
            <TermsText />
          </div>
        </details>
      </Section>
    </div>
  );
}
