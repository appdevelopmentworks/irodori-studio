'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { button } from '@/components/ui';
import { ProjectBar } from '@/features/projects/ProjectBar';
import { codeOf } from '@/lib/jobs';
import { useScriptStore } from '@/store/script';
import { useSidecarStore } from '@/store/sidecar';
import { useVoicesStore } from '@/store/voices';

import { loadRecent, openScript } from './actions';
import { ExportSection } from './ExportSection';
import { ImportSection } from './ImportSection';
import { LinesSection } from './LinesSection';
import { SettingsSection } from './SettingsSection';
import { SpeakersSection } from './SpeakersSection';

const PREVIEW_DELAY_MS = 250;

/** 台本: multi-speaker dialogue — lines from text or a table, a voice per speaker, takes
 * per line, and one file per line plus the merged drama with subtitles (requirements
 * §6.7). */
export function ScriptScreen() {
  const { t } = useTranslation();
  const recentId = useId();
  const api = useSidecarStore((s) => s.api);
  const model = useSidecarStore((s) => s.capabilities);
  const loadError = useSidecarStore((s) => s.loadError);
  const script = useScriptStore((s) => s.script);
  const recent = useScriptStore((s) => s.recent);
  const template = useScriptStore((s) => s.draft.namingTemplate);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    void loadRecent();
    void useVoicesStore.getState().load();
  }, [api]);

  // File names the naming template gives, for the settings preview and every line.
  const scriptId = script?.id;
  const version = script?.updated_at;
  useEffect(() => {
    if (!api || !scriptId) return;
    let active = true;
    const timer = setTimeout(() => {
      api.previewFileNames(scriptId, template).then(
        (result) => active && useScriptStore.getState().setFileNames(result.names),
        (err: unknown) => active && useScriptStore.getState().setFileNames(null, codeOf(err)),
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, scriptId, version, template]);

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
      await openScript(id, model.params);
    } catch (err) {
      setError(codeOf(err));
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t('script.title')}</h1>
          {script ? <p className="truncate text-sm text-zinc-500">{script.title}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {recent && recent.length > 0 ? (
            <>
              <label htmlFor={recentId} className="text-sm text-zinc-500">
                {t('script.recent.label')}
              </label>
              <select
                id={recentId}
                value={script?.id ?? ''}
                onChange={(event) => event.target.value && void open(event.target.value)}
                className="max-w-64 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="">{t('script.recent.choose')}</option>
                {recent.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t('script.recent.option', {
                      title: item.title,
                      rendered: item.rendered,
                      total: item.lines,
                    })}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          {script ? (
            <button
              type="button"
              onClick={() => useScriptStore.getState().startNew()}
              className={button}
            >
              {t('script.recent.new')}
            </button>
          ) : null}
        </div>
      </div>
      <ProjectBar kind="script" id={script?.id ?? null} title={script?.title ?? ''} />
      {error ? <ErrorNotice error={{ code: error }} /> : null}

      <ImportSection model={model} />
      {script ? (
        <>
          <SpeakersSection />
          <SettingsSection model={model} />
          <LinesSection model={model} />
          <ExportSection model={model} />
        </>
      ) : (
        <p className="text-sm text-zinc-500">{t('script.empty')}</p>
      )}
    </div>
  );
}
