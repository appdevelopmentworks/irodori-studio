'use client';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { useApiServerStore } from '@/store/apiServer';
import { useSidecarStore } from '@/store/sidecar';

import { ConfigSection } from './ConfigSection';
import { RequestLog } from './RequestLog';
import { StatusSection } from './StatusSection';
import { UsageSection } from './UsageSection';

const POLL_MS = 2000;

/** API サーバー: the OpenAI- and VOICEVOX-compatible listener for other apps, sharing the
 * app's queue (requirements §6.10, D21). */
export function ApiServerScreen() {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const config = useApiServerStore((s) => s.config);
  const loadError = useApiServerStore((s) => s.loadError);

  useEffect(() => {
    if (!api) return;
    void useApiServerStore.getState().load();
    const timer = setInterval(() => void useApiServerStore.getState().poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [api]);

  if (loadError) {
    return (
      <div className="p-6">
        <ErrorNotice error={{ code: loadError }} />
      </div>
    );
  }
  if (!config) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{t('apiServer.title')}</h1>
        <p className="text-sm text-zinc-500">{t('apiServer.intro')}</p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ConfigSection config={config} />
        <StatusSection />
      </div>
      <UsageSection />
      <RequestLog />
    </div>
  );
}
