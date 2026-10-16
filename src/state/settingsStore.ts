/**
 * UI preferences, persisted to localStorage. Deep-merged over DEFAULTS.
 *
 * Only what the frontend alone needs lives here; backend-relevant settings
 * (transfers, reconnects, editor overrides) are the core's `settings.json`
 * (`getSettings` / `saveSettings`). The theme has its own store
 * (`themeStore`), as in Podium.
 */

import { create } from "zustand";

import type { CompareRule } from "../ipc/types";

export interface Settings {
  appearance: { reduceMotion: boolean };
  browser: {
    /** Show dotfiles and other hidden entries in the file panes. */
    showHidden: boolean;
  };
  preview: {
    /** Files larger than this (MB) are not previewed inline. */
    maxSizeMb: number;
  };
  /** The Sync dialog's last choices, used for the next sync. */
  sync: {
    rule: CompareRule;
    /** Don't overwrite files that are newer on the target. */
    protectNewer: boolean;
    /** `null`: follow the panes' show-hidden setting (skip when hidden). */
    skipHidden: boolean | null;
    copyEmptyFolders: boolean;
    /** Skip files larger than `maxSizeMb`. */
    limitSize: boolean;
    maxSizeMb: number;
  };
}

export const PREVIEW_MAX_SIZE_MIN_MB = 1;
export const PREVIEW_MAX_SIZE_MAX_MB = 100;
/** Bounds of the sync size cap (`MAX_FILE_SIZE_MB_LIMIT` in the core). */
export const SYNC_MAX_SIZE_MIN_MB = 1;
export const SYNC_MAX_SIZE_MAX_MB = 1024 * 1024;

export const DEFAULTS: Settings = {
  appearance: { reduceMotion: false },
  browser: { showHidden: false },
  preview: { maxSizeMb: 10 },
  sync: {
    rule: "sizeOrDate",
    protectNewer: true,
    skipHidden: null,
    copyEmptyFolders: true,
    limitSize: false,
    maxSizeMb: 100,
  },
};

const STORAGE_KEY = "iris.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    // Spread saved values over defaults per section, so a blob whose shape
    // predates a newer field still gets that field's default.
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      appearance: { ...DEFAULTS.appearance, ...saved.appearance },
      browser: { ...DEFAULTS.browser, ...saved.browser },
      preview: { ...DEFAULTS.preview, ...saved.preview },
      sync: { ...DEFAULTS.sync, ...saved.sync },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

/** Sets the manual reduced-motion override on <html>. Turning the toggle on
 *  sets `data-reduce-motion="true"` (matched by the global.css guard); turning
 *  it off removes the attribute, so the OS-level media query still applies. */
export function applyReduceMotion(reduce: boolean): void {
  const el = document.documentElement;
  if (reduce) {
    el.dataset.reduceMotion = "true";
  } else {
    delete el.dataset.reduceMotion;
  }
}

interface SettingsState extends Settings {
  set: <K extends keyof Settings>(
    section: K,
    patch: Partial<Settings[K]>,
  ) => void;
  resetSettings: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const initial = load();
  applyReduceMotion(initial.appearance.reduceMotion);
  return {
    ...initial,
    set: (section, patch) => {
      const next = { ...get()[section], ...patch } as Settings[typeof section];
      const merged = { ...get(), [section]: next };
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            appearance: merged.appearance,
            browser: merged.browser,
            preview: merged.preview,
            sync: merged.sync,
          }),
        );
      } catch {
        /* quota exceeded: keep the in-memory value for this session */
      }
      if (section === "appearance") {
        applyReduceMotion((next as Settings["appearance"]).reduceMotion);
      }
      set({ [section]: next } as Partial<SettingsState>);
    },
    resetSettings: () => {
      localStorage.removeItem(STORAGE_KEY);
      applyReduceMotion(DEFAULTS.appearance.reduceMotion);
      set({ ...structuredClone(DEFAULTS) });
    },
  };
});
