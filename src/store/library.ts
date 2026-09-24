// Library screen state: history filters, the loaded page of entries, selection, opened
// details, and regenerate jobs by entry. Kept while the user switches screens; memory
// only (D11).
import { create } from 'zustand';

import type { JobPhase } from '@/lib/jobs';
import type { HistoryEntry, HistorySummary, HistoryUsage } from '@/lib/types';

export type LibraryTab = 'history' | 'presets';

export interface LibraryFilters {
  q: string;
  /** '' (all), a library voice id, or 'none'. */
  voice: string;
  /** Local dates 'YYYY-MM-DD' ('' = open). */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: LibraryFilters = { q: '', voice: '', from: '', to: '' };

interface LibraryStore {
  tab: LibraryTab;
  filters: LibraryFilters;
  items: HistorySummary[] | null;
  total: number;
  usage: HistoryUsage | null;
  selected: string[];
  details: Record<string, HistoryEntry>;
  /** Regenerate jobs by the entry they came from. */
  jobs: Record<string, JobPhase>;
  /** Error codes by entry (a failed action on that row). */
  errors: Record<string, string>;

  setTab: (tab: LibraryTab) => void;
  setFilters: (patch: Partial<LibraryFilters>) => void;
  setPage: (items: HistorySummary[], total: number, append: boolean) => void;
  setUsage: (usage: HistoryUsage) => void;
  replaceItem: (entry: HistorySummary) => void;
  removeItems: (ids: string[]) => void;
  toggle: (id: string) => void;
  setSelected: (ids: string[]) => void;
  setDetail: (id: string, entry: HistoryEntry | null) => void;
  setJob: (id: string, phase: JobPhase | null) => void;
  setError: (id: string, code: string | null) => void;
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

export const useLibraryStore = create<LibraryStore>((set) => ({
  tab: 'history',
  filters: EMPTY_FILTERS,
  items: null,
  total: 0,
  usage: null,
  selected: [],
  details: {},
  jobs: {},
  errors: {},

  setTab: (tab) => set({ tab }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  setPage: (items, total, append) =>
    set((s) => {
      const merged = append && s.items ? [...s.items, ...items] : items;
      const ids = new Set(merged.map((item) => item.id));
      return { items: merged, total, selected: s.selected.filter((id) => ids.has(id)) };
    }),
  setUsage: (usage) => set({ usage }),
  replaceItem: (entry) =>
    set((s) => ({ items: s.items?.map((item) => (item.id === entry.id ? entry : item)) ?? null })),
  removeItems: (ids) =>
    set((s) => {
      const gone = new Set(ids);
      const items = s.items?.filter((item) => !gone.has(item.id)) ?? null;
      return {
        items,
        total: Math.max(0, s.total - ids.length),
        selected: s.selected.filter((id) => !gone.has(id)),
      };
    }),
  toggle: (id) =>
    set((s) => ({
      selected: s.selected.includes(id)
        ? s.selected.filter((other) => other !== id)
        : [...s.selected, id],
    })),
  setSelected: (selected) => set({ selected }),
  setDetail: (id, entry) =>
    set((s) => ({ details: entry ? { ...s.details, [id]: entry } : without(s.details, id) })),
  setJob: (id, phase) =>
    set((s) => ({ jobs: phase ? { ...s.jobs, [id]: phase } : without(s.jobs, id) })),
  setError: (id, code) =>
    set((s) => ({ errors: code ? { ...s.errors, [id]: code } : without(s.errors, id) })),
}));
