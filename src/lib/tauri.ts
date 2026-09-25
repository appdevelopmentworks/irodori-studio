// Typed wrappers around Tauri commands, events and plugins. Components never call
// invoke()/listen() directly (docs/coding-conventions.md). Command errors reject
// with an error code string (src-tauri/src/error.rs), mapped to text in errors.ts.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';

import type {
  BootState,
  DataRootInfo,
  DeviceChoice,
  FolderKind,
  LogName,
  LogTail,
  MoveProgress,
  MoveTarget,
  ProbeReport,
  RuntimeOverride,
  SettingsInfo,
  SetupProgress,
  StatusPayload,
  UpdateState,
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

// Settings (Session 9).

export const getSettingsInfo = (): Promise<SettingsInfo> =>
  invoke<SettingsInfo>('get_settings_info');

/** Save a device / precision override (null: as set up); the sidecar restarts. */
export const setRuntime = (runtime: RuntimeOverride | null): Promise<void> =>
  invoke('set_runtime', { runtime });

export const restartSidecar = (): Promise<void> => invoke('restart_sidecar');

/** Stop the app and re-run setup for dependencies, model files and the self-check. */
export const repairInstallation = (): Promise<void> => invoke('repair_installation');

export const openFolder = (folder: FolderKind): Promise<void> => invoke('open_folder', { folder });

export const readLog = (name: LogName): Promise<LogTail> => invoke<LogTail>('read_log', { name });

export const getUpdateState = (): Promise<UpdateState> => invoke<UpdateState>('get_update_state');

export const checkForUpdates = (): Promise<UpdateState> =>
  invoke<UpdateState>('check_for_updates');

export const setUpdateCheck = (enabled: boolean): Promise<void> =>
  invoke('set_update_check', { enabled });

export const skipUpdate = (version: string): Promise<void> => invoke('skip_update', { version });

export const openReleasePage = (): Promise<void> => invoke('open_release_page');

export const inspectMoveTarget = (path: string): Promise<MoveTarget> =>
  invoke<MoveTarget>('inspect_move_target', { path });

export const startDataMove = (path: string): Promise<void> => invoke('start_data_move', { path });

export const cancelDataMove = (): Promise<void> => invoke('cancel_data_move');

export const getMoveProgress = (): Promise<MoveProgress> =>
  invoke<MoveProgress>('get_move_progress');

export const deleteOldDataRoot = (): Promise<void> => invoke('delete_old_data_root');

export const dismissMoveResult = (): Promise<void> => invoke('dismiss_move_result');

export const onUpdate = (handler: (state: UpdateState) => void): Promise<UnlistenFn> =>
  listen<UpdateState>('app://update', (event) => handler(event.payload));

export const onMoveProgress = (handler: (progress: MoveProgress) => void): Promise<UnlistenFn> =>
  listen<MoveProgress>('app://move', (event) => handler(event.payload));

export const onStatus = (handler: (payload: StatusPayload) => void): Promise<UnlistenFn> =>
  listen<StatusPayload>('app://status', (event) => handler(event.payload));

export const onSetupProgress = (handler: (progress: SetupProgress) => void): Promise<UnlistenFn> =>
  listen<SetupProgress>('setup://progress', (event) => handler(event.payload));

export const onSetupLog = (handler: (line: string) => void): Promise<UnlistenFn> =>
  listen<string>('setup://log', (event) => handler(event.payload));

export interface FileFilter {
  name: string;
  extensions: string[];
}

/** Native single-file picker; resolves to null when cancelled. */
export async function pickFile(title: string, filters: FileFilter[]): Promise<string | null> {
  const selected = await open({ directory: false, multiple: false, title, filters });
  return typeof selected === 'string' ? selected : null;
}

/** Native save dialog (asks before overwriting); resolves to null when cancelled. */
export async function pickSavePath(
  title: string,
  defaultPath: string,
  filters: FileFilter[],
): Promise<string | null> {
  return (await save({ title, defaultPath, filters })) ?? null;
}

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
