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

/** "Only files changed in" choices of the Sync dialog. */
export type ChangedWithinPreset =
  "any" | "hour" | "today" | "day" | "week" | "since";
import type { ActionId, ShortcutOverrides } from "../lib/keymap";

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
    /** Only compare files changed in this window (`any`: everything). */
    changedWithin: ChangedWithinPreset;
    /** The "Since…" moment, as a `datetime-local` value (local time). */
    changedSince: string | null;
  };
  /**
   * Only the shortcuts the user changed (action → its bindings); the rest
   * follow `lib/keymap`'s defaults, also for actions added later.
   */
  shortcuts: ShortcutOverrides;
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
    changedWithin: "any",
    changedSince: null,
  },
  shortcuts: {},
};

const STORAGE_KEY = "iris.settings";

/** Keeps the entries that are a non-empty list of strings for a known action. */
function loadShortcuts(saved: unknown): ShortcutOverrides {
  const out: ShortcutOverrides = {};
  if (!saved || typeof saved !== "object") return out;
  for (const [action, list] of Object.entries(saved)) {
    if (
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((b) => typeof b === "string")
    ) {
      out[action as ActionId] = list;
    }
  }
  return out;
}

const PRESETS: ChangedWithinPreset[] = [
  "any",
  "hour",
  "today",
  "day",
  "week",
  "since",
];

/** The saved sync choices over the defaults; an unknown window is "any". */
function loadSync(
  saved: Partial<Settings["sync"]> | undefined,
): Settings["sync"] {
  const sync = { ...DEFAULTS.sync, ...saved };
  if (!PRESETS.includes(sync.changedWithin)) sync.changedWithin = "any";
  if (typeof sync.changedSince !== "string") sync.changedSince = null;
  return sync;
}

function persist(s: Settings): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        appearance: s.appearance,
        browser: s.browser,
        preview: s.preview,
        sync: s.sync,
        shortcuts: s.shortcuts,
      }),
    );
  } catch {
    /* quota exceeded: keep the in-memory value for this session */
  }
}

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
      sync: loadSync(saved.sync),
      shortcuts: loadShortcuts(saved.shortcuts),
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
  /** Rebinds an action; `null` puts its default back. */
  setShortcut: (action: ActionId, bindings: string[] | null) => void;
  /** Puts every shortcut back to its default. */
  resetShortcuts: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const initial = load();
  applyReduceMotion(initial.appearance.reduceMotion);
  return {
    ...initial,
    set: (section, patch) => {
      const next = { ...get()[section], ...patch } as Settings[typeof section];
      persist({ ...get(), [section]: next });
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
    setShortcut: (action, bindings) => {
      const next = { ...get().shortcuts };
      if (bindings && bindings.length > 0) next[action] = bindings;
      else delete next[action];
      persist({ ...get(), shortcuts: next });
      set({ shortcuts: next });
    },
    resetShortcuts: () => {
      persist({ ...get(), shortcuts: {} });
      set({ shortcuts: {} });
    },
  };
});
