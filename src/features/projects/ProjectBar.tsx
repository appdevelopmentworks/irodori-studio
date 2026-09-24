'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { WarningIcon } from '@/components/icons';
import { button } from '@/components/ui';
import { loadRecent as loadNarrations, openNarration } from '@/features/narration/actions';
import { loadRecent as loadScripts, openScript } from '@/features/script/actions';
import { codeOf } from '@/lib/jobs';
import { pickFile, pickSavePath } from '@/lib/tauri';
import type { ProjectKind } from '@/lib/types';
import { useAppStore } from '@/store/app';
import { useNavStore } from '@/store/nav';
import { useProjectStore } from '@/store/projects';
import { useSidecarStore } from '@/store/sidecar';

const EXTENSION = 'iroproj';
// Characters a file name may not contain on Windows or macOS.
const UNSAFE = /[\\/:*?"<>|]/g;

/** `<data-root>/projects/<title>.iroproj`, where projects are kept by default (D23). */
function defaultPath(dataRoot: string | null | undefined, title: string): string {
  const name = `${title.replace(UNSAFE, '_').trim() || 'project'}.${EXTENSION}`;
  if (!dataRoot) return name;
  const separator = dataRoot.includes('\\') ? '\\' : '/';
  return [dataRoot.replace(/[\\/]+$/, ''), 'projects', name].join(separator);
}

/** Save the open narration or script as one `.iroproj` file with its adopted takes, or
 * open a project file as a new narration or script (on its own screen). */
export function ProjectBar({
  kind,
  id,
  title,
}: {
  kind: ProjectKind;
  id: string | null;
  title: string;
}) {
  const { t } = useTranslation();
  const api = useSidecarStore((s) => s.api);
  const model = useSidecarStore((s) => s.capabilities);
  const dataRoot = useAppStore((s) => s.boot?.data_root);
  const opened = useProjectStore((s) => s.opened);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (!api || !model) return null;
  const filters = [{ name: t('projects.filter'), extensions: [EXTENSION] }];

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(codeOf(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!id) return;
      const path = await pickSavePath(t('projects.saveTitle'), defaultPath(dataRoot, title), filters);
      if (!path) return;
      const file = await api.saveProject(kind, id, path);
      setSaved(file.path);
    });

  const open = () =>
    run(async () => {
      const path = await pickFile(t('projects.openTitle'), filters);
      if (!path) return;
      const result = await api.openProject(path);
      useProjectStore.getState().setOpened(result);
      setSaved(null);
      if (result.kind === 'narration') {
        await openNarration(result.id, model.params);
        void loadNarrations();
        useNavStore.getState().setScreen('narration');
      } else {
        await openScript(result.id, model.params);
        void loadScripts();
        useNavStore.getState().setScreen('script');
      }
    });

  const missing =
    opened && opened.kind === kind && opened.id === id
      ? [...opened.missing_voices, ...opened.missing_lora]
      : [];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => void open()} className={button}>
          {t('projects.open')}
        </button>
        <button type="button" disabled={busy || !id} onClick={() => void save()} className={button}>
          {t('projects.save')}
        </button>
      </div>
      {saved ? (
        <p className="text-right text-xs break-all text-emerald-700 dark:text-emerald-400">
          {t('projects.saved', { path: saved })}
        </p>
      ) : null}
      {missing.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <WarningIcon className="mt-0.5 h-4 w-4 text-amber-600" />
          <p className="flex-1">{t('projects.missing', { items: missing.join(t('projects.separator')) })}</p>
          <button
            type="button"
            onClick={() => useProjectStore.getState().setOpened(null)}
            className="text-xs text-sky-700 hover:underline dark:text-sky-400"
          >
            {t('projects.dismiss')}
          </button>
        </div>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </div>
  );
}
