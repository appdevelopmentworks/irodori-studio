'use client';

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { button, card, input, primaryButton } from '@/components/ui';
import { useEmbeddingPicker } from '@/features/quick/useEmbeddingPicker';
import { codeOf } from '@/lib/jobs';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { applySaved } from './jobs';

/** (d) A voice from a Speaker Inversion embedding (`.speaker.safetensors`); the file is
 * copied into the library. */
export function NewEmbeddingVoice() {
  const { t } = useTranslation();
  const nameId = useId();
  const api = useSidecarStore((s) => s.api);
  const draft = useVoicesStore((s) => s.embeddingDraft);
  const update = useVoicesStore((s) => s.updateEmbeddingDraft);
  const pickEmbedding = useEmbeddingPicker();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!api) return null;

  const choose = async () => {
    const path = await pickEmbedding();
    if (path) update({ path });
  };

  let problem: string | null = null;
  if (!draft.name.trim()) problem = t('voiceStudio.new.problems.needName');
  else if (!draft.path) problem = t('voiceStudio.new.problems.needEmbedding');

  const save = async () => {
    if (problem || !draft.path) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.createVoice({
        name: draft.name.trim(),
        source: 'embedding',
        embedding_path: draft.path,
      });
      const store = useVoicesStore.getState();
      store.updateEmbeddingDraft({ name: '', path: null });
      applySaved(saved);
      store.open({ kind: 'voice', voiceId: saved.voice.id });
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{t('voiceStudio.new.titles.embedding')}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {t('voiceStudio.new.intros.embedding')}
        </p>
      </div>
      <div className={`${card} space-y-4`}>
        <div className="space-y-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t('voiceStudio.fields.name')}
          </label>
          <input
            id={nameId}
            value={draft.name}
            maxLength={100}
            placeholder={t('voiceStudio.fields.namePlaceholder')}
            onChange={(event) => update({ name: event.target.value })}
            className={input}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t('voiceStudio.embedding.file')}</p>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate rounded-md border border-zinc-300 px-2 py-1.5 font-mono text-xs dark:border-zinc-700">
              {draft.path ?? t('quick.voice.embeddingNone')}
            </p>
            <button type="button" onClick={() => void choose()} className={button}>
              {t('quick.voice.chooseEmbedding')}
            </button>
          </div>
          <p className="text-xs text-zinc-500">{t('quick.voice.embeddingHint')}</p>
        </div>
      </div>
      {error ? <ErrorNotice error={{ code: error }} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={saving || problem !== null}
          onClick={() => void save()}
          className={primaryButton}
        >
          {t('voiceStudio.new.save')}
        </button>
        {problem ? <p className="text-sm text-amber-700 dark:text-amber-300">{problem}</p> : null}
      </div>
    </div>
  );
}
