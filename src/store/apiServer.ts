// The external API listener (D21) for the API Server screen: the saved configuration, the
// status with the request log (polled while the screen is open) and the VOICEVOX styles.
// Memory only (D11).
import { create } from 'zustand';

import { codeOf } from '@/lib/jobs';
import type { ApiServerConfig, ApiServerStatus, ApiStyle } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';

interface ApiServerStore {
  config: ApiServerConfig | null;
  status: ApiServerStatus | null;
  styles: ApiStyle[] | null;
  /** Error code when the configuration could not be loaded. */
  loadError: string | null;
  load: () => Promise<void>;
  poll: () => Promise<void>;
  /** Save and apply (the listener starts, restarts or stops); resolves to an error code
   * or null. */
  save: (config: ApiServerConfig) => Promise<string | null>;
}

export const useApiServerStore = create<ApiServerStore>((set) => ({
  config: null,
  status: null,
  styles: null,
  loadError: null,

  load: async () => {
    const api = useSidecarStore.getState().api;
    if (!api) return;
    try {
      const [config, status, styles] = await Promise.all([
        api.getApiServerConfig(),
        api.getApiServerStatus(),
        api.getApiServerStyles(),
      ]);
      set({ config, status, styles, loadError: null });
    } catch (err) {
      set({ loadError: codeOf(err) });
    }
  },

  poll: async () => {
    const api = useSidecarStore.getState().api;
    if (!api) return;
    try {
      set({ status: await api.getApiServerStatus() });
    } catch {
      // The next poll tries again; the status bar shows a sidecar that does not answer.
    }
  },

  save: async (config) => {
    const api = useSidecarStore.getState().api;
    if (!api) return 'internal';
    try {
      const status = await api.putApiServerConfig(config);
      set({ config, status });
      return null;
    } catch (err) {
      return codeOf(err);
    }
  },
}));
