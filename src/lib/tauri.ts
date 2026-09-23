// Typed wrappers around Tauri commands, events and plugins. Components never call
// invoke()/listen() directly (docs/coding-conventions.md). Command errors reject
// with an error code string (src-tauri/src/error.rs), mapped to text in errors.ts.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';

import type {
  BootState,
  DataRootInfo,
  DeviceChoice,
  ProbeReport,
  SetupProgress,
  StatusPayload,
} from './types';

export { isTauri };

export const getBootState = (): Promise<BootState> => invoke<BootState>('get_boot_state');

export const setLocale = (locale: string): Promise<void> => invoke('set_locale', { locale });

export const acceptTerms = (): Promise<void> => invoke('accept_terms');

export const probePlatform = (): Promise<ProbeReport> => invoke<ProbeReport>('probe_platform');

export const setDeviceChoice = (choice: DeviceChoice): Promise<void> =>
  invoke('set_device_choice', { choice });

export const inspectDataRoot = (path: string): Promise<DataRootInfo> =>
  invoke<DataRootInfo>('inspect_data_root', { path });

export const setDataRoot = (path: string): Promise<void> => invoke('set_data_root', { path });

export const startSetup = (): Promise<void> => invoke('start_setup');

export const getSetupProgress = (): Promise<SetupProgress> =>
  invoke<SetupProgress>('get_setup_progress');

export const getSidecarPort = (): Promise<number> => invoke<number>('get_sidecar_port');

export const retryStartup = (): Promise<void> => invoke('retry_startup');

export const onStatus = (handler: (payload: StatusPayload) => void): Promise<UnlistenFn> =>
  listen<StatusPayload>('app://status', (event) => handler(event.payload));

export const onSetupProgress = (handler: (progress: SetupProgress) => void): Promise<UnlistenFn> =>
  listen<SetupProgress>('setup://progress', (event) => handler(event.payload));

export const onSetupLog = (handler: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>('setup://log', (event) => handler(event.payload));

/** Native folder picker; resolves to null when cancelled. */
export async function pickDirectory(title: string, defaultPath?: string): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title, defaultPath });
  return typeof selected === 'string' ? selected : null;
}

/** Sets the native window title (requires `core:window:allow-set-title`). */
export async function setWindowTitle(title: string): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setTitle(title);
}
