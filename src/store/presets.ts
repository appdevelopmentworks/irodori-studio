// Parameter presets from the sidecar (requirements §6.8), shared by every parameter panel
// and the Library screen. Memory only (D11).
import { create } from 'zustand';

import type { Preset } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';

interface PresetStore {
  presets: Preset[] | null;
  load: () => Promise<void>;
}

export const usePresetStore = create<PresetStore>((set) => ({
  presets: null,
  load: async () => {
    const api = useSidecarStore.getState().api;
    if (!api) return;
    try {
      set({ presets: await api.listPresets() });
    } catch {
      // The list is a convenience; the panels work without it.
    }
  },
}));
