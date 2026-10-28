/**
 * The core's persisted settings (`settings.json`: parallel transfers,
 * reconnect attempts, editor overrides), mirrored for the Settings dialog.
 *
 * `load` re-reads them (on first use and on `settings:changed`); `save`
 * writes a patch and keeps what the core stored (it normalizes). UI-only
 * preferences live in `settingsStore` instead.
 */

import { create } from "zustand";

import { getSettings, saveSettings, toIpcError } from "../ipc/commands";
import type { IrisSettings } from "../ipc/types";
import { toastError } from "./toastStore";

/** Bounds of `parallelTransfers` (`PARALLEL_TRANSFERS_RANGE` in the core). */
export const PARALLEL_TRANSFERS_MIN = 1;
export const PARALLEL_TRANSFERS_MAX = 16;
/** Bounds of `reconnectAttempts` (`RECONNECT_ATTEMPTS_RANGE`; 0 = never). */
export const RECONNECT_ATTEMPTS_MIN = 0;
export const RECONNECT_ATTEMPTS_MAX = 20;

interface BackendSettingsState {
  /** `null` until the first load arrived. */
  settings: IrisSettings | null;
  load: () => Promise<void>;
  save: (patch: Partial<IrisSettings>) => Promise<void>;
}

export const useBackendSettingsStore = create<BackendSettingsState>(
  (set, get) => ({
    settings: null,

    load: async () => {
      try {
        const settings = await getSettings();
        if (settings) set({ settings });
      } catch (e) {
        toastError("Could not load the settings", toIpcError(e).message);
      }
    },

    save: async (patch) => {
      const current = get().settings;
      if (!current) return;
      try {
        set({ settings: await saveSettings({ ...current, ...patch }) });
      } catch (e) {
        toastError("Could not save the settings", toIpcError(e).message);
        await get().load();
      }
    },
  }),
);
