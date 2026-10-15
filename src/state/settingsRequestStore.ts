/**
 * One-shot "open Settings on this tab" request, so a component deep in the
 * tree (e.g. an inline "check Settings" link) can reach the modal `App` owns.
 */

import { create } from "zustand";

/**
 * Settings tabs. Phase 0 ships General; Transfers (parallel transfers,
 * reconnects) and Editors (per-extension overrides) join it later.
 */
export type SettingsTabId = "general";

interface SettingsRequestState {
  request: SettingsTabId | null;
  open: (tab: SettingsTabId) => void;
  clear: () => void;
}

export const useSettingsRequestStore = create<SettingsRequestState>((set) => ({
  request: null,
  open: (tab) => set({ request: tab }),
  clear: () => set({ request: null }),
}));
