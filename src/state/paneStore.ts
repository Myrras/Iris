/**
 * State of the two file panes (Local and Remote): which filesystem and folder
 * each shows, its listing, and the view state around it (sort, filter, hidden
 * toggle, selection, Back history).
 *
 * Every navigation re-reads the folder from the backend; a listing only
 * replaces the pane's contents once it arrived, so a failed navigation leaves
 * the current folder in place. Responses are tokened per pane, so a slow
 * listing can never overwrite a newer one.
 */

import { create } from "zustand";

import { homeDir, listDir, toIpcError } from "../ipc/commands";
import type { Entry, FsTarget } from "../ipc/types";
import { DEFAULT_SORT, type SortKey, type SortSpec } from "../lib/entries";
import { parentPath } from "../lib/path";
import type { SelectionState } from "../lib/selection";
import { toastError } from "./toastStore";

export type PaneId = "local" | "remote";

export interface PaneState extends SelectionState {
  /** `null` until opened; the remote pane returns to `null` when closed. */
  target: FsTarget | null;
  /** The folder on screen; `null` before the first listing arrived. */
  path: string | null;
  entries: Entry[];
  loading: boolean;
  /** Why the pane has nothing to show (the very first listing failed). */
  error: string | null;
  /** Folders visited before this one, most recent last (Back). */
  history: string[];
  sort: SortSpec;
  filter: string;
  /** `null` follows the "show hidden files" setting; a toggle overrides it. */
  showHidden: boolean | null;
}

export function initialPane(): PaneState {
  return {
    target: null,
    path: null,
    entries: [],
    loading: false,
    error: null,
    history: [],
    sort: DEFAULT_SORT,
    filter: "",
    showHidden: null,
    selection: [],
    anchor: null,
    cursor: null,
  };
}

interface PaneStoreState {
  panes: Record<PaneId, PaneState>;
  /** Show `target` in a pane, starting at `path` (`null` = home folder). */
  open: (pane: PaneId, target: FsTarget, path: string | null) => Promise<void>;
  /** Open a folder, remembering the current one for Back. */
  navigate: (pane: PaneId, path: string) => Promise<void>;
  back: (pane: PaneId) => Promise<void>;
  up: (pane: PaneId) => Promise<void>;
  /** Re-read the current folder, keeping filter and (surviving) selection. */
  refresh: (pane: PaneId) => Promise<void>;
  /** Sort by `key`; the same key again flips the direction. */
  setSort: (pane: PaneId, key: SortKey) => void;
  setFilter: (pane: PaneId, filter: string) => void;
  setShowHidden: (pane: PaneId, show: boolean) => void;
  setSelection: (pane: PaneId, selection: SelectionState) => void;
  /** Detach the pane from its filesystem (the remote pane's welcome state). */
  close: (pane: PaneId) => void;
}

/** Latest request per pane; an older response is dropped on arrival. */
const tokens: Record<PaneId, number> = { local: 0, remote: 0 };

type LoadMode = "push" | "replace" | "refresh";

export const usePaneStore = create<PaneStoreState>((set, get) => {
  const patch = (pane: PaneId, p: Partial<PaneState>) =>
    set((s) => ({ panes: { ...s.panes, [pane]: { ...s.panes[pane], ...p } } }));

  /**
   * List `path` and, if still the latest request, show it. Resolves `true`
   * when the folder is on screen. `history` is the Back stack to store with it.
   */
  async function load(
    pane: PaneId,
    path: string,
    mode: LoadMode,
    history?: string[],
  ): Promise<boolean> {
    const target = get().panes[pane].target;
    if (!target) return false;
    const token = ++tokens[pane];
    patch(pane, { loading: true });
    try {
      const entries = await listDir(target, path);
      if (token !== tokens[pane]) return false;
      const current = get().panes[pane];
      if (mode === "refresh") {
        const exists = new Set(entries.map((e) => e.path));
        const keep = (p: string | null) => (p && exists.has(p) ? p : null);
        patch(pane, {
          entries,
          loading: false,
          error: null,
          selection: current.selection.filter((p) => exists.has(p)),
          anchor: keep(current.anchor),
          cursor: keep(current.cursor),
        });
      } else {
        const nextHistory =
          history ??
          (mode === "push" && current.path && current.path !== path
            ? [...current.history, current.path]
            : current.history);
        patch(pane, {
          path,
          entries,
          loading: false,
          error: null,
          history: nextHistory,
          filter: "",
          selection: [],
          anchor: null,
          cursor: null,
        });
      }
      return true;
    } catch (e) {
      if (token !== tokens[pane]) return false;
      const err = toIpcError(e);
      const hasFolder = get().panes[pane].path !== null;
      patch(pane, {
        loading: false,
        error: hasFolder ? null : err.message,
      });
      // A lost session is shown by the pane itself (disconnected state).
      if (err.kind !== "notConnected") {
        toastError(`Could not open ${path}`, err.message);
      }
      return false;
    }
  }

  return {
    panes: { local: initialPane(), remote: initialPane() },

    open: async (pane, target, path) => {
      // Keep the view preferences; drop everything about the old location.
      const { sort, showHidden } = get().panes[pane];
      tokens[pane] += 1;
      patch(pane, {
        ...initialPane(),
        target,
        sort,
        showHidden,
        loading: true,
      });
      try {
        if (path !== null && (await load(pane, path, "replace", []))) return;
        // No start folder, or it could not be opened: the home folder.
        const home = await homeDir(target);
        await load(pane, home, "replace", []);
      } catch (e) {
        const err = toIpcError(e);
        patch(pane, { loading: false, error: err.message });
        if (err.kind !== "notConnected") {
          toastError("Could not open the home folder", err.message);
        }
      }
    },

    navigate: async (pane, path) => {
      await load(pane, path, "push");
    },

    back: async (pane) => {
      const { history } = get().panes[pane];
      const previous = history[history.length - 1];
      if (previous === undefined) return;
      await load(pane, previous, "replace", history.slice(0, -1));
    },

    up: async (pane) => {
      const { path } = get().panes[pane];
      const parent = path ? parentPath(path) : null;
      if (parent) await load(pane, parent, "push");
    },

    refresh: async (pane) => {
      const { path } = get().panes[pane];
      if (path) await load(pane, path, "refresh");
    },

    setSort: (pane, key) => {
      const { sort } = get().panes[pane];
      patch(pane, {
        sort:
          sort.key === key
            ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
            : { key, dir: "asc" },
      });
    },

    setFilter: (pane, filter) => patch(pane, { filter }),
    setShowHidden: (pane, showHidden) => patch(pane, { showHidden }),
    setSelection: (pane, selection) => patch(pane, selection),

    close: (pane) => {
      tokens[pane] += 1;
      const { sort, showHidden } = get().panes[pane];
      patch(pane, { ...initialPane(), sort, showHidden });
    },
  };
});
