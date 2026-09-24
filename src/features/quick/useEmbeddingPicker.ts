'use client';

import { useTranslation } from 'react-i18next';

import { pickFile } from '@/lib/tauri';

/** Native picker for a Speaker Inversion file. Upstream names them `*.speaker.safetensors`
 * (the default filter); any `*.safetensors` is offered as well, because the sidecar checks
 * the content and gives the copy it hands upstream the required suffix. */
export function useEmbeddingPicker(): () => Promise<string | null> {
  const { t } = useTranslation();
  return () =>
    pickFile(t('quick.voice.embeddingTitle'), [
      { name: t('quick.voice.embeddingFilter'), extensions: ['speaker.safetensors'] },
      { name: t('quick.voice.safetensorsFilter'), extensions: ['safetensors'] },
    ]);
}
