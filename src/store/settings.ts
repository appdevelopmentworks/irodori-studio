// The Settings screen's data (Session 9): what Rust reports (paths, update check, the
// runtime choices), the runtime's package licenses, and the open tab. Memory only (D11).
import { create } from 'zustand';

import { getSettingsInfo } from '@/lib/tauri';
import type { PackageLicense, SettingsInfo } from '@/lib/types';
import { useSidecarStore } from '@/store/sidecar';

export const SETTINGS_TABS = ['general', 'storage', 'engine', 'output', 'logs', 'about'] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

interface SettingsStore {
  tab: SettingsTab;
  info: SettingsInfo | null;
  licenses: PackageLicense[] | null;
  setTab: (tab: SettingsTab) => void;
  load: () => Promise<void>;
  patch: (patch: Partial<SettingsInfo>) => void;
  loadLicenses: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  tab: 'general',
  info: null,
  licenses: null,
  setTab: (tab) => set({ tab }),
  load: async () => {
    try {
      set({ info: await getSettingsInfo() });
    } catch {
      // The sections that need it stay hidden.
    }
  },
  patch: (patch) => {
    const info = get().info;
    if (info) set({ info: { ...info, ...patch } });
  },
  loadLicenses: async () => {
    const api = useSidecarStore.getState().api;
    if (!api || get().licenses) return;
    try {
      set({ licenses: await api.getLicenses() });
    } catch {
      // Listed only when the sidecar answers.
    }
  },
}));
