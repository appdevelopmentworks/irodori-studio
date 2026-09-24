'use client';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { NewClipVoice } from './NewClipVoice';
import { NewDesignVoice } from './NewDesignVoice';
import { NewEmbeddingVoice } from './NewEmbeddingVoice';
import { card } from './ui';
import { VoiceEditor } from './VoiceEditor';
import { VoiceList } from './VoiceList';

/** ボイススタジオ: design, import, record or bring voices, edit them, set their defaults
 * and keep them in the library (requirements §6.5). */
export function VoiceStudioScreen() {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const model = useSidecarStore((s) => s.capabilities);
  const sidecarError = useSidecarStore((s) => s.loadError);
  const panel = useVoicesStore((s) => s.panel);
  const voice = useVoicesStore((s) => {
    const open = s.panel;
    return open.kind === 'voice' ? s.voices?.find((v) => v.id === open.voiceId) : undefined;
  });

  // Re-read the library whenever the screen opens (the API may have changed it).
  useEffect(() => {
    if (api) void useVoicesStore.getState().load();
  }, [api]);

  if (sidecarError) {
    return (
      <div className="p-6">
        <ErrorNotice error={{ code: sidecarError }} />
      </div>
    );
  }
  if (!model || !api) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  let content = (
    <div className={`${card} space-y-2`}>
      <p className="text-sm font-medium">{t('voiceStudio.empty.title')}</p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('voiceStudio.empty.body')}</p>
    </div>
  );
  if (panel.kind === 'voice' && voice) {
    content = <VoiceEditor key={voice.id} voice={voice} model={model} />;
  } else if (panel.kind === 'new') {
    if (panel.source === 'designed') content = <NewDesignVoice model={model} />;
    else if (panel.source === 'embedding') content = <NewEmbeddingVoice />;
    else content = <NewClipVoice key={panel.source} model={model} />;
  }

  return (
    <div className="mx-auto grid max-w-7xl gap-6 p-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="min-w-0">
        <VoiceList model={model} />
      </div>
      <div className="min-w-0">{content}</div>
    </div>
  );
}
