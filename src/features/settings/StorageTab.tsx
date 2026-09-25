'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '@/components/ErrorNotice';
import { Spinner } from '@/components/icons';
import { button, dangerButton, primaryButton } from '@/components/ui';
import { errorCodeOf } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import {
  deleteOldDataRoot,
  dismissMoveResult,
  inspectMoveTarget,
  openFolder,
  pickDirectory,
  startDataMove,
} from '@/lib/tauri';
import type { FolderKind, MoveTarget } from '@/lib/types';
import { useAppStore } from '@/store/app';
import { useSettingsStore } from '@/store/settings';
import { useSidecarStore } from '@/store/sidecar';

import { Section } from './Section';

const FOLDERS: FolderKind[] = ['data_root', 'models', 'projects', 'exports', 'logs'];

/** Where the app keeps its data (D16): open the folders, move the whole data root. */
export function StorageTab() {
  const { t } = useTranslation();
  const info = useSettingsStore((s) => s.info);
  const [error, setError] = useState<string | null>(null);

  if (!info) return null;
  return (
    <div className="space-y-6">
      <MoveResult />
      <Section title={t('settings.storage.title')} description={t('settings.storage.hint')}>
        <p className="rounded bg-zinc-100 px-2 py-1 font-mono text-xs break-all dark:bg-zinc-800">
          {info.data_root}
        </p>
        <div className="flex flex-wrap gap-2">
          {FOLDERS.map((folder) => (
            <button
              key={folder}
              type="button"
              onClick={() => {
                setError(null);
                openFolder(folder).catch((err: unknown) => setError(errorCodeOf(err)));
              }}
              className={button}
            >
              {t(`settings.storage.open.${folder}`)}
            </button>
          ))}
        </div>
        {error ? <ErrorNotice error={{ code: error }} /> : null}
      </Section>
      <MoveSection />
    </div>
  );
}

/** Pick a folder, check it (space, emptiness), confirm, then the app moves everything. */
function MoveSection() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const busyQueue = useSidecarStore((s) => (s.system?.queue_length ?? 0) > 0);
  const [target, setTarget] = useState<MoveTarget | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    setError(null);
    const folder = await pickDirectory(t('settings.move.pickTitle'));
    if (!folder) return;
    setChecking(true);
    try {
      setTarget(await inspectMoveTarget(folder));
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setChecking(false);
    }
  };

  const start = async () => {
    if (!target) return;
    setError(null);
    try {
      await startDataMove(target.path);
    } catch (err) {
      setError(errorCodeOf(err));
    }
  };

  return (
    <Section title={t('settings.move.title')} description={t('settings.move.hint')}>
      <div className="flex items-center gap-3">
        <button type="button" disabled={checking} onClick={() => void choose()} className={button}>
          {t('settings.move.choose')}
        </button>
        {checking ? <Spinner className="text-zinc-400" /> : null}
      </div>
      {target ? (
        <div className="space-y-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-zinc-500">{t('settings.move.to')}</dt>
            <dd className="font-mono text-xs break-all">{target.path}</dd>
            <dt className="text-zinc-500">{t('settings.move.required')}</dt>
            <dd className="tabular-nums">{formatBytes(target.required_bytes, locale)}</dd>
            {target.free_bytes != null ? (
              <>
                <dt className="text-zinc-500">{t('settings.move.free')}</dt>
                <dd className="tabular-nums">{formatBytes(target.free_bytes, locale)}</dd>
              </>
            ) : null}
          </dl>
          {target.proposed ? (
            <p className="text-xs text-zinc-500">{t('settings.move.proposed')}</p>
          ) : null}
          {target.issues.map((issue) => (
            <ErrorNotice key={issue} error={{ code: issue }} />
          ))}
          {target.issues.length === 0 ? (
            <>
              <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-600 dark:text-zinc-400">
                <li>{t('settings.move.notes.stop')}</li>
                <li>{t('settings.move.notes.caches')}</li>
                <li>{t('settings.move.notes.keep')}</li>
              </ul>
              {busyQueue ? (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t('settings.move.queueBusy')}
                </p>
              ) : null}
              <div className="flex gap-2">
                <button type="button" onClick={() => void start()} className={primaryButton}>
                  {t('settings.move.start')}
                </button>
                <button type="button" onClick={() => setTarget(null)} className={button}>
                  {t('settings.common.cancel')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </Section>
  );
}

/** How the last move ended; after a success, the old folder can be deleted. */
function MoveResult() {
  const { t } = useTranslation();
  const move = useAppStore((s) => s.move);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outcome =
    move &&
    !move.running &&
    (move.phase === 'done' || move.phase === 'failed' || move.phase === 'cancelled')
      ? move.phase
      : null;
  if (!move || !outcome) return null;

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteOldDataRoot();
    } catch (err) {
      setError(errorCodeOf(err));
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <section
      role="status"
      className={`space-y-3 rounded-xl border p-4 text-sm ${
        outcome === 'done'
          ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/40'
          : 'border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40'
      }`}
    >
      <p className="font-medium">{t(`settings.move.result.${outcome}`)}</p>
      {outcome === 'failed' && move.error ? <ErrorNotice error={move.error} /> : null}
      {outcome === 'done' && move.old_root ? (
        <p>{t('settings.move.result.oldRoot', { path: move.old_root })}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {outcome === 'done' && move.old_root && !confirming ? (
          <button type="button" onClick={() => setConfirming(true)} className={dangerButton}>
            {t('settings.move.result.delete')}
          </button>
        ) : null}
        {!confirming ? (
          <button type="button" onClick={() => void dismissMoveResult()} className={button}>
            {outcome === 'done' && move.old_root
              ? t('settings.move.result.keep')
              : t('settings.common.close')}
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div className="space-y-2">
          <p className="text-red-700 dark:text-red-300">
            {t('settings.move.result.deleteConfirm', {
              path: move.old_root ?? '',
            })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => void remove()}
              className={dangerButton}
            >
              {t('settings.move.result.deleteNow')}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={button}>
              {t('settings.common.cancel')}
            </button>
            {deleting ? <Spinner className="text-zinc-400" /> : null}
          </div>
        </div>
      ) : null}
      {error ? <ErrorNotice error={{ code: error }} /> : null}
    </section>
  );
}
