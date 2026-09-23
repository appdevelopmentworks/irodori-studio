'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice, type ErrorLike } from '@/components/ErrorNotice';
import { Spinner, WarningIcon } from '@/components/icons';
import { errorCodeOf } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { getBootState, inspectDataRoot, pickDirectory, setDataRoot, startSetup } from '@/lib/tauri';
import type { DataRootInfo } from '@/lib/types';
import { useAppStore } from '@/store/app';

import { StepFooter } from './parts';

/** Data root choice (D16); Next saves it and starts the installation. */
export function StorageStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const boot = useAppStore((s) => s.boot);
  const patchBoot = useAppStore((s) => s.patchBoot);
  const defaultRoot = boot?.default_data_root ?? '';
  const [path, setPath] = useState(boot?.data_root ?? defaultRoot);
  const [checked, setChecked] = useState<{ path: string; info: DataRootInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;

  useEffect(() => {
    let active = true;
    inspectDataRoot(path)
      .then((info) => active && setChecked({ path, info }))
      .catch((err: unknown) => active && setError({ code: errorCodeOf(err) }));
    return () => {
      active = false;
    };
  }, [path]);

  const info = checked?.path === path ? checked.info : null;

  const choose = async () => {
    const selected = await pickDirectory(t('setup.storage.pickerTitle'), path || undefined);
    if (selected) setPath(selected);
  };

  const next = async () => {
    setBusy(true);
    setError(null);
    try {
      await setDataRoot(path);
      const fresh = await getBootState();
      patchBoot({ data_root: fresh.data_root, logs_dir: fresh.logs_dir });
      await startSetup();
      onNext();
    } catch (err) {
      setError({ code: errorCodeOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t('setup.storage.heading')}</h2>
      {info ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {t('setup.storage.description', { size: formatBytes(info.required_bytes, locale) })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm break-all dark:border-zinc-700 dark:bg-zinc-950">
          {path}
        </code>
        <button
          type="button"
          onClick={() => void choose()}
          disabled={busy}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {t('setup.storage.change')}
        </button>
        {defaultRoot && path !== defaultRoot ? (
          <button
            type="button"
            onClick={() => setPath(defaultRoot)}
            disabled={busy}
            className="rounded-md px-3 py-2 text-sm text-sky-700 hover:underline disabled:opacity-50 dark:text-sky-400"
          >
            {t('setup.storage.useDefault')}
          </button>
        ) : null}
      </div>

      {info ? (
        <div className="space-y-2 text-sm">
          {info.free_bytes !== null ? (
            <p className="text-zinc-500">
              {t('setup.storage.free', { size: formatBytes(info.free_bytes, locale) })}
            </p>
          ) : null}
          {info.issues.map((code) => (
            <p key={code} className="flex gap-2 text-red-700 dark:text-red-300">
              <WarningIcon className="mt-0.5 h-4 w-4" />
              {t(`errors.codes.${code}`)}
            </p>
          ))}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Spinner className="h-4 w-4" /> {t('setup.storage.checking')}
        </p>
      )}

      {error ? <ErrorNotice error={error} /> : null}
      <StepFooter
        onBack={onBack}
        onNext={() => void next()}
        nextDisabled={!info || info.issues.length > 0}
        busy={busy}
      />
    </div>
  );
}
