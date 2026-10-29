/**
 * The core's persisted settings (`settings.json`: parallel transfers,
 * reconnect attempts, editor overrides, sync excludes, Local favorites),
 * mirrored for the Settings dialog and the sidebar's Local section.
 *
 * `load` re-reads them (on first use and on `settings:changed`); `save`
 * writes a patch and keeps what the core stored (it normalizes; the core
 * keeps its own Local favorites whatever the patch holds).
 * `setLocalFavorites` is the one way to change those. UI-only preferences
 * live in `settingsStore` instead.
 */

import { create } from "zustand";

import {
  getSettings,
  saveSettings,
  setLocalFavorites,
  toIpcError,
} from "../ipc/commands";
import type { Favorite, IrisSettings } from "../ipc/types";
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
  /**
   * Replace the Local favorites: applied locally at once (once loaded),
   * then sent, then re-read. A refusal toasts with `failure` as the title
   * and puts the backend's list back; never rejects. Resolves whether the
   * backend stored it.
   */
  setLocalFavorites: (
    favorites: Favorite[],
    failure: string,
  ) => Promise<boolean>;
}

/** The latest Local favorites change; an older one finishing late is ignored. */
let favoritesSeq = 0;

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

    setLocalFavorites: async (favorites, failure) => {
      const previous = get().settings?.localFavorites;
      const seq = ++favoritesSeq;
      const put = (localFavorites: Favorite[]) => {
        const current = get().settings;
        if (current) set({ settings: { ...current, localFavorites } });
      };
      put(favorites);
      let stored = true;
      try {
        await setLocalFavorites(favorites);
      } catch (e) {
        stored = false;
        if (seq !== favoritesSeq) return false;
        if (previous) put(previous);
        toastError(failure, toIpcError(e).message);
      }
      if (seq === favoritesSeq) await get().load();
      return stored;
    },
  }),
);
