// Connection to the sidecar once the app is ready: the API client, data that is fixed for
// a session (capabilities, emoji palette, preferences) and polled status (system, engine).
// Memory only — never browser storage (D11).
import { create } from 'zustand';

import { type Api, ApiError, createApi } from '@/lib/api';
import type {
  EmojiItem,
  EngineStatus,
  ModelCapabilities,
  Preferences,
  SystemInfo,
} from '@/lib/types';

interface SidecarStore {
  api: Api | null;
  capabilities: ModelCapabilities | null;
  emoji: EmojiItem[] | null;
  preferences: Preferences | null;
  system: SystemInfo | null;
  engine: EngineStatus | null;
  /** Error code when the session data could not be loaded. */
  loadError: string | null;
  /** The last poll failed: the sidecar is not answering. */
  unreachable: boolean;
  connect: (port: number) => Promise<void>;
  poll: () => Promise<void>;
  disconnect: () => void;
}

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : 'internal');

export const useSidecarStore = create<SidecarStore>((set, get) => ({
  api: null,
  capabilities: null,
  emoji: null,
  preferences: null,
  system: null,
  engine: null,
  loadError: null,
  unreachable: false,

  connect: async (port) => {
    const api = createApi(port);
    set({ api, loadError: null });
    try {
      const [capabilities, emoji, preferences] = await Promise.all([
        api.getCapabilities(),
        api.getEmoji(),
        api.getPreferences(),
      ]);
      if (get().api === api) set({ capabilities, emoji, preferences });
    } catch (err) {
      if (get().api === api) set({ loadError: codeOf(err) });
    }
    await get().poll();
  },

  poll: async () => {
    const api = get().api;
    if (!api) return;
    try {
      const [system, health] = await Promise.all([api.getSystem(), api.getHealth()]);
      if (get().api === api) set({ system, engine: health.engine, unreachable: false });
    } catch {
      if (get().api === api) set({ unreachable: true });
    }
  },

  disconnect: () =>
    set({
      api: null,
      capabilities: null,
      emoji: null,
      preferences: null,
      system: null,
      engine: null,
      loadError: null,
      unreachable: false,
    }),
}));
