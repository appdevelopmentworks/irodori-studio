// What happened when a project file was opened (D23), shown on the screen it opened on:
// library voices or LoRA adapters it used that are not here. Memory only (D11).
import { create } from 'zustand';

import type { ProjectOpened } from '@/lib/types';

interface ProjectStore {
  opened: ProjectOpened | null;
  setOpened: (opened: ProjectOpened | null) => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  opened: null,
  setOpened: (opened) => set({ opened }),
}));
