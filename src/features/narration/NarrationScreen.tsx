'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { button } from '@/components/ui';
import { ProjectBar } from '@/features/projects/ProjectBar';
import { codeOf } from '@/lib/jobs';
import { useNarrationStore } from '@/store/narration';
import { useSidecarStore } from '@/store/sidecar';

import { loadRecent, openNarration } from './actions';
import { ChunkSection } from './ChunkSection';
import { ExportSection } from './ExportSection';
import { ManuscriptSection } from './ManuscriptSection';
import { SettingsSection } from './SettingsSection';

/** ナレーション: long-form text in chunks — split, render with one consistent voice,
 * check, fix, and export one file with subtitles (requirements §6.6, D18). */
export function NarrationScreen() {
  const { t } = useTranslation();
  const recentId = useId();
  const api = useSidecarStore((s) => s.api);
  const model = useSidecarStore((s) => s.capabilities);
  const loadError = useSidecarStore((s) => s.loadError);
  const narration = useNarrationStore((s) => s.narration);
  const recent = useNarrationStore((s) => s.recent);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (api) void loadRecent();
  }, [api]);

  if (loadError) {
    return (
      <div className="p-6">
        <ErrorNotice error={{ code: loadError }} />
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

  const open = async (id: string) => {
    setError(null);
    try {
      await openNarration(id, model.params);
    } catch (err) {
      setError(codeOf(err));
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t('narration.title')}</h1>
          {narration ? (
            <p className="truncate text-sm text-zinc-500">{narration.title}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {recent && recent.length > 0 ? (
            <>
              <label htmlFor={recentId} className="text-sm text-zinc-500">
                {t('narration.recent.label')}
              </label>
              <select
                id={recentId}
                value={narration?.id ?? ''}
                onChange={(event) => event.target.value && void open(event.target.value)}
                className="max-w-64 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">{t('narration.recent.choose')}</option>
                {recent.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t('narration.recent.option', {
                      title: item.title,
                      rendered: item.rendered,
                      total: item.chunks,
                    })}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {narration ? (
            <button
              type="button"
              onClick={() => useNarrationStore.getState().startNew()}
              className={button}
            >
              {t('narration.recent.new')}
            </button>
          ) : null}
        </div>
      </div>
      <ProjectBar kind="narration" id={narration?.id ?? null} title={narration?.title ?? ''} />
      {error ? <ErrorNotice error={{ code: error }} /> : null}

      <ManuscriptSection model={model} />
      {narration ? (
        <>
          <SettingsSection model={model} />
          <ChunkSection model={model} />
          <ExportSection model={model} />
        </>
      ) : (
        <p className="text-sm text-zinc-500">{t('narration.empty')}</p>
      )}
    </div>
  );
}
