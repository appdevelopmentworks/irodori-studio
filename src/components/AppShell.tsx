'use client';

import { useEffect } from 'react';

import { ApiServerScreen } from '@/features/api-server/ApiServerScreen';
import { LibraryScreen } from '@/features/library/LibraryScreen';
import { NarrationScreen } from '@/features/narration/NarrationScreen';
import { QuickScreen } from '@/features/quick/QuickScreen';
import { ScriptScreen } from '@/features/script/ScriptScreen';
import { VoiceStudioScreen } from '@/features/voice-studio/VoiceStudioScreen';
import { getSidecarPort } from '@/lib/tauri';
import { useAppStore } from '@/store/app';
import { useNavStore } from '@/store/nav';
import { useSidecarStore } from '@/store/sidecar';

import { ComingSoon } from './ComingSoon';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';

const POLL_MS = 2000;

/** The app once the model is ready: sidebar navigation, the active screen, status bar. */
export function AppShell() {
  const screen = useNavStore((s) => s.screen);
  const setPort = useAppStore((s) => s.setPort);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sidecar = useSidecarStore.getState();
    getSidecarPort()
      .then(async (port) => {
        if (!active) return;
        setPort(port);
        await sidecar.connect(port);
        if (active) timer = setInterval(() => void sidecar.poll(), POLL_MS);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      clearInterval(timer);
      sidecar.disconnect();
    };
  }, [setPort]);

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {screen === 'quick' ? (
            <QuickScreen />
          ) : screen === 'voices' ? (
            <VoiceStudioScreen />
          ) : screen === 'narration' ? (
            <NarrationScreen />
          ) : screen === 'script' ? (
            <ScriptScreen />
          ) : screen === 'library' ? (
            <LibraryScreen />
          ) : screen === 'apiServer' ? (
            <ApiServerScreen />
          ) : (
            <ComingSoon screen={screen} />
          )}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
