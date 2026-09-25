'use client';

import { useTranslation } from 'react-i18next';

import { card } from '@/components/ui';
import { formatTime } from '@/lib/format';
import { useApiServerStore } from '@/store/apiServer';

const statusColor = (status: number) =>
  status >= 500
    ? 'text-red-700 dark:text-red-300'
    : status >= 400
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-emerald-700 dark:text-emerald-400';

/** The last requests to the external API, newest first (kept in the sidecar's memory). */
export function RequestLog() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const requests = useApiServerStore((s) => s.status?.requests);

  if (!requests) return null;
  return (
    <section className={`${card} space-y-3`}>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t('apiServer.log.title')}</h2>
        <p className="text-xs text-zinc-500">{t('apiServer.log.hint')}</p>
      </div>
      {requests.length === 0 ? (
        <p className="text-sm text-zinc-500">{t('apiServer.log.empty')}</p>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-white text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('apiServer.log.time')}</th>
                <th className="py-1 pr-3 font-medium">{t('apiServer.log.family')}</th>
                <th className="py-1 pr-3 font-medium">{t('apiServer.log.request')}</th>
                <th className="py-1 pr-3 font-medium">{t('apiServer.log.status')}</th>
                <th className="py-1 pr-3 text-right font-medium">{t('apiServer.log.duration')}</th>
                <th className="py-1 font-medium">{t('apiServer.log.client')}</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((entry, index) => (
                <tr
                  key={`${entry.time}:${index}`}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="py-1 pr-3 whitespace-nowrap tabular-nums">
                    {formatTime(entry.time, locale)}
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {t(`apiServer.log.families.${entry.family}`)}
                  </td>
                  <td className="max-w-80 truncate py-1 pr-3 font-mono" title={entry.path}>
                    {`${entry.method} ${entry.path}`}
                  </td>
                  <td className={`py-1 pr-3 font-mono tabular-nums ${statusColor(entry.status)}`}>
                    {entry.status}
                  </td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap tabular-nums">
                    {t('apiServer.log.ms', { ms: entry.duration_ms })}
                  </td>
                  <td className="py-1 font-mono whitespace-nowrap">{entry.client}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
