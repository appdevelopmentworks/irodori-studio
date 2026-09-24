'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { SetupWizard } from '@/features/setup/SetupWizard';
import i18n from '@/i18n';
import { matchLocale } from '@/i18n/config';
import {
  getBootState,
  isTauri,
  onSetupLog,
  onSetupProgress,
  onStatus,
} from '@/lib/tauri';
import { useAppStore } from '@/store/app';

import { AppShell } from './AppShell';
import { ErrorScreen } from './ErrorScreen';
import { Screen, Splash } from './Screen';
import { StartupScreen } from './StartupScreen';

const noSubscription = () => () => {};

/** Boots from Rust (settings, status, setup progress) and routes by app status. */
export function AppRoot() {
  const { t } = useTranslation();
  // null while prerendering and hydrating (no Tauri in Node), then the real answer.
  const inTauri = useSyncExternalStore(noSubscription, isTauri, () => null);
  const boot = useAppStore((s) => s.boot);
  const status = useAppStore((s) => s.status);

  useEffect(() => {
    if (!inTauri) return;
    const store = useAppStore.getState();
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const keep = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };

    (async () => {
      // Subscribe before reading the state so no event is missed in between.
      keep(await onStatus(store.applyStatus));
      keep(await onSetupProgress(store.setSetup));
      keep(await onSetupLog(store.appendLog));
      const state = await getBootState();
      if (disposed) return;
      await i18n.changeLanguage(state.locale ?? matchLocale(navigator.languages));
      store.setBoot(state);
    })().catch(() => undefined);

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
    // Boot exactly once: `useTranslation().i18n` changes identity on every language
    // switch, which would re-run this and re-apply the saved locale over a preview.
  }, [inTauri]);

  if (inTauri === null) return <Splash />;
  if (!inTauri) {
    return (
      <Screen>
        <p>{t('common.desktopOnly')}</p>
      </Screen>
    );
  }
  if (!boot) return <Splash />;

  switch (status) {
    case 'setup':
      return <SetupWizard />;
    case 'starting':
    case 'loading_model':
      return <StartupScreen />;
    case 'ready':
      return <AppShell />;
    case 'error':
      return <ErrorScreen />;
  }
}
