/**
 * One-shot "open Settings on this tab" request, so a component deep in the
 * tree (e.g. an inline "check Settings" link) can reach the modal `App` owns.
 */

import { create } from "zustand";

/**
 * Settings tabs: General (UI prefs), Transfers (the core's parallel
 * transfers and reconnect attempts) and Editors (per-extension editor
 * overrides).
 */
export type SettingsTabId = "general" | "transfers" | "editors";

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
