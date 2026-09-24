// Which app screen is showing (memory only, D11).
import { create } from 'zustand';

export const SCREENS = [
  'quick',
  'voices',
  'narration',
  'script',
  'library',
  'apiServer',
  'settings',
] as const;

export type ScreenId = (typeof SCREENS)[number];

interface NavStore {
  screen: ScreenId;
  setScreen: (screen: ScreenId) => void;
}

export const useNavStore = create<NavStore>((set) => ({
  screen: 'quick',
  setScreen: (screen) => set({ screen }),
}));
