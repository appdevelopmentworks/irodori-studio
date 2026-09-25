'use client';

import { useTranslation } from 'react-i18next';

import { CopyButton } from '@/components/CopyButton';
import { ErrorNotice } from '@/components/ErrorNotice';
import { card, smallButton } from '@/components/ui';
import { useApiServerStore } from '@/store/apiServer';

const DOTS = { running: 'bg-emerald-500', failed: 'bg-red-500', stopped: 'bg-zinc-400' };

/** Running or not (with why it could not start), and the URLs other apps connect to. */
export function StatusSection() {
  const { t } = useTranslation();
  const status = useApiServerStore((s) => s.status);

  if (!status) return null;
  const state = status.running ? 'running' : status.error ? 'failed' : 'stopped';

  return (
    <section className={`${card} space-y-4`}>
      <h2 className="text-sm font-semibold">{t('apiServer.status.title')}</h2>
      <p className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
        <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${DOTS[state]}`} />
        {t(`apiServer.status.${state}`)}
      </p>
      {status.error ? <ErrorNotice error={{ code: status.error }} /> : null}
      {status.running ? (
        <dl className="space-y-3 text-sm">
          <UrlList
            label={t('apiServer.status.openaiBase')}
            urls={status.urls.map((url) => `${url}/v1`)}
          />
          <UrlList label={t('apiServer.status.voicevoxBase')} urls={status.urls} />
        </dl>
      ) : state === 'stopped' ? (
        <p className="text-xs text-zinc-500">{t('apiServer.status.stoppedHint')}</p>
      ) : null}
    </section>
  );
}

function UrlList({ label, urls }: { label: string; urls: string[] }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-zinc-500">{label}</dt>
      {urls.map((url) => (
        <dd key={url} className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-800">
            {url}
          </code>
          <CopyButton text={url} className={smallButton} />
        </dd>
      ))}
    </div>
  );
}
