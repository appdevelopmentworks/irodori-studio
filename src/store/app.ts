// App lifecycle state: boot snapshot from Rust, status events, setup progress, and the
// sidecar port. Memory only — settings persist through Rust, never browser storage (D11).
import { create } from 'zustand';

import type { AppError, AppStatus, BootState, SetupProgress, StatusPayload } from '@/lib/types';

const MAX_LOG_LINES = 500;

interface AppStore {
  boot: BootState | null;
  status: AppStatus;
  error: AppError | null;
  setup: SetupProgress | null;
  logs: string[];
  port: number | null;
  setBoot: (boot: BootState) => void;
  patchBoot: (patch: Partial<BootState>) => void;
  applyStatus: (payload: StatusPayload) => void;
  setSetup: (progress: SetupProgress) => void;
  appendLog: (line: string) => void;
  setPort: (port: number | null) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  boot: null,
  status: 'setup',
  error: null,
  setup: null,
  logs: [],
  port: null,
  setBoot: (boot) => set({ boot, status: boot.status, error: boot.error, setup: boot.setup }),
  patchBoot: (patch) => set((s) => (s.boot ? { boot: { ...s.boot, ...patch } } : {})),
  applyStatus: ({ status, error }) =>
    set((s) => ({ status, error, port: status === 'ready' ? s.port : null })),
  setSetup: (setup) => set({ setup }),
  appendLog: (line) => set((s) => ({ logs: [...s.logs.slice(-(MAX_LOG_LINES - 1)), line] })),
  setPort: (port) => set({ port }),
}));
