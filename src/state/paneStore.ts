/**
 * State of the two file panes (Local and Remote): which filesystem and folder
 * each shows, its listing, and the view state around it (sort, filter, hidden
 * toggle, selection, Back history).
 *
 * Every navigation re-reads the folder from the backend; a listing only
 * replaces the pane's contents once it arrived, so a failed navigation leaves
 * the current folder in place. Responses are tokened per pane, so a slow
 * listing can never overwrite a newer one.
 *
 * The file operations (new folder, rename, delete, chmod) live here too: each
 * calls the backend, then re-reads the folder so the pane mirrors the disk.
 *
 * ## Tabs
 * This store holds the panes of the ACTIVE tab only; `tabsStore` keeps the
 * panes of the tabs in the background as snapshots and swaps them in with
 * `restore` on a switch. `restore` (like `open` and `close`) bumps the
 * per-pane request tokens and epochs, so a listing or `open` still in flight
 * for the tab that was left is dropped instead of landing in the new one.
 */

import { create } from "zustand";

import {
  chmod as chmodPaths,
  deletePaths,
  homeDir,
  listDir,
  mkdir,
  rename as renamePath,
  stat,
  toIpcError,
} from "../ipc/commands";
import type { BatchReport, Entry, FsTarget, IpcError } from "../ipc/types";
import {
  DEFAULT_SORT,
  isDirLike,
  type SortKey,
  type SortSpec,
} from "../lib/entries";
import { NEW_FOLDER_NAME, nameError, uniqueName } from "../lib/fileName";
import { goToErrorMessage, resolveGoTo, usesHome } from "../lib/goToPath";
import { formatOctalMode } from "../lib/mode";
import { baseName, childToward, joinPath, parentPath } from "../lib/path";
import { isWindows } from "../lib/platform";
import type { SelectionState } from "../lib/selection";
import { useSettingsStore } from "./settingsStore";
import { toastError, toastSuccess } from "./toastStore";

export type PaneId = "local" | "remote";

/** The outcome of "go to path": `message` is shown inline in the field. */
export type GoToResult = { ok: true } | { ok: false; message: string };

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
  /** The entry being renamed inline, by path. */
  editing: string | null;
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
    editing: null,
    selection: [],
    anchor: null,
    cursor: null,
  };
}

/**
 * The entry the pane is "on" (what Preview shows): the keyboard cursor when
 * it is selected, else the last selected entry.
 */
export function focusedEntry(pane: PaneState): Entry | null {
  const { cursor, selection, entries } = pane;
  const path =
    cursor && selection.includes(cursor)
      ? cursor
      : selection[selection.length - 1];
  return path ? (entries.find((e) => e.path === path) ?? null) : null;
}

/**
 * What an action applies to: the selected entries in listing order, or the
 * cursor entry when nothing is selected.
 */
export function actionTargets(pane: PaneState): Entry[] {
  if (pane.selection.length > 0) {
    const selected = new Set(pane.selection);
    return pane.entries.filter((e) => selected.has(e.path));
  }
  const cursor = pane.entries.find((e) => e.path === pane.cursor);
  return cursor ? [cursor] : [];
}

/** "1 item" / "3 items". */
export function itemCount(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}

/** Where local deletes go, in the platform's own words. */
export const TRASH_NAME = isWindows ? "Recycle Bin" : "Trash";

interface PaneStoreState {
  panes: Record<PaneId, PaneState>;
  /** Show `target` in a pane, starting at `path` (`null` = home folder). */
  open: (pane: PaneId, target: FsTarget, path: string | null) => Promise<void>;
  /** Open a folder, remembering the current one for Back. */
  navigate: (pane: PaneId, path: string) => Promise<void>;
  /**
   * Go to what the user typed: an absolute or relative path (`..`, `~`).
   * A folder opens like `navigate` (Back works); a file opens its folder
   * with the file selected. Nothing changes on failure.
   */
  goTo: (pane: PaneId, input: string) => Promise<GoToResult>;
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
  /**
   * Show another tab's panes (a snapshot), dropping every request in flight
   * for the ones on screen. The caller re-lists them (`tabsStore`).
   */
  restore: (panes: Record<PaneId, PaneState>, active: PaneId) => void;

  /** The pane the user last worked in (Preview follows it). */
  active: PaneId;
  setActive: (pane: PaneId) => void;

  /**
   * Create "untitled folder" (numbered when taken) in the current folder,
   * select it and start renaming it.
   */
  newFolder: (pane: PaneId) => Promise<void>;
  /** Start renaming the entry at `path` inline. */
  startRename: (pane: PaneId, path: string) => void;
  cancelRename: (pane: PaneId) => void;
  /** Rename the entry at `from` to `name` in the same folder; it stays selected. */
  commitRename: (pane: PaneId, from: string, name: string) => Promise<void>;
  /** Delete `paths` (local: to the Trash; remote: permanently). */
  remove: (pane: PaneId, paths: string[]) => Promise<void>;
  /** Set the permission bits of `paths`, optionally recursively. */
  chmod: (
    pane: PaneId,
    paths: string[],
    mode: number,
    recursive: boolean,
  ) => Promise<void>;
}

/** Latest request per pane; an older response is dropped on arrival. */
const tokens: Record<PaneId, number> = { local: 0, remote: 0 };
/**
 * Bumped whenever a pane gets another location or tab (`open`, `close`,
 * `restore`); an `open` that finds it changed after an await stops, so it
 * never carries on into the home folder of a pane it no longer owns.
 */
const epochs: Record<PaneId, number> = { local: 0, remote: 0 };

type LoadMode = "push" | "replace" | "refresh";

interface LoadOptions {
  /** Select this entry once the folder is shown (if it is visible). */
  select?: string;
  /** Handle a failed listing here instead of toasting it. */
  onError?: (err: IpcError) => void;
}

export const usePaneStore = create<PaneStoreState>((set, get) => {
  const patch = (pane: PaneId, p: Partial<PaneState>) =>
    set((s) => ({ panes: { ...s.panes, [pane]: { ...s.panes[pane], ...p } } }));

  /** Select just `path` (it becomes the cursor and anchor). */
  const selectOnly = (pane: PaneId, path: string) =>
    patch(pane, { selection: [path], anchor: path, cursor: path });

  /**
   * List `path` and, if still the latest request, show it. Resolves `true`
   * when the folder is on screen. `history` is the Back stack to store with it.
   */
  async function load(
    pane: PaneId,
    path: string,
    mode: LoadMode,
    history?: string[],
    options: LoadOptions = {},
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
          editing: keep(current.editing),
        });
      } else {
        const nextHistory =
          history ??
          (mode === "push" && current.path && current.path !== path
            ? [...current.history, current.path]
            : current.history);
        // Going up (Up, breadcrumb, Back): select the child we came from,
        // like Finder. Hidden entries stay unselected while hidden.
        const showHidden =
          current.showHidden ?? useSettingsStore.getState().browser.showHidden;
        const from = current.path ? childToward(path, current.path) : null;
        const wanted = options.select ?? from;
        const origin = wanted
          ? entries.find((e) => e.path === wanted && (showHidden || !e.hidden))
          : undefined;
        patch(pane, {
          path,
          entries,
          loading: false,
          error: null,
          history: nextHistory,
          filter: "",
          editing: null,
          selection: origin ? [origin.path] : [],
          anchor: origin ? origin.path : null,
          cursor: origin ? origin.path : null,
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
      if (options.onError) options.onError(err);
      // A lost session is shown by the pane itself (disconnected state).
      else if (err.kind !== "notConnected") {
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
      const epoch = ++epochs[pane];
      patch(pane, {
        ...initialPane(),
        target,
        sort,
        showHidden,
        loading: true,
      });
      try {
        if (path !== null && (await load(pane, path, "replace", []))) return;
        if (epoch !== epochs[pane]) return;
        // No start folder, or it could not be opened: the home folder.
        const home = await homeDir(target);
        if (epoch !== epochs[pane]) return;
        await load(pane, home, "replace", []);
      } catch (e) {
        if (epoch !== epochs[pane]) return;
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

    goTo: async (pane, input) => {
      const { target, path } = get().panes[pane];
      if (!target || path === null) {
        return { ok: false, message: "Nothing to go to" };
      }
      const epoch = epochs[pane];
      const windows = target.kind === "local" && isWindows;
      const refused = (e: unknown): GoToResult => {
        const err = toIpcError(e);
        return { ok: false, message: goToErrorMessage(err.kind, err.message) };
      };
      let home: string | null = null;
      if (usesHome(input, windows)) {
        try {
          home = await homeDir(target);
        } catch (e) {
          return refused(e);
        }
      }
      const resolved = resolveGoTo(input, { cwd: path, home, windows });
      if (resolved === null) return { ok: true };
      let entry: Entry;
      try {
        entry = await stat(target, resolved);
      } catch (e) {
        return refused(e);
      }
      // The pane moved on (tab switch, disconnect) while we were asking.
      if (epoch !== epochs[pane]) return { ok: true };

      let folder = resolved;
      let select: string | undefined;
      if (!isDirLike(entry)) {
        const broken =
          entry.kind.type === "symlink" && entry.kind.targetKind === null;
        const parent = parentPath(resolved);
        if (broken || parent === null) {
          return { ok: false, message: "No such folder" };
        }
        folder = parent;
        select = resolved;
      }
      const failure: { err: IpcError | null } = { err: null };
      await load(pane, folder, "push", undefined, {
        select,
        onError: (err) => {
          failure.err = err;
        },
      });
      return failure.err ? refused(failure.err) : { ok: true };
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
      epochs[pane] += 1;
      const { sort, showHidden } = get().panes[pane];
      patch(pane, { ...initialPane(), sort, showHidden });
    },

    restore: (panes, active) => {
      for (const id of ["local", "remote"] as const) {
        tokens[id] += 1;
        epochs[id] += 1;
      }
      // A snapshot taken mid-listing would spin forever: nothing in flight
      // belongs to it any more.
      set({
        panes: {
          local: { ...panes.local, loading: false },
          remote: { ...panes.remote, loading: false },
        },
        active,
      });
    },

    active: "local",
    setActive: (pane) => {
      if (get().active !== pane) set({ active: pane });
    },

    newFolder: async (pane) => {
      const { target, path, entries } = get().panes[pane];
      if (!target || path === null) return;
      const taken = new Set(entries.map((e) => e.name));
      // The listing can be stale: on a clash, take the next number.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const name = uniqueName(NEW_FOLDER_NAME, taken);
        const created = joinPath(path, name);
        try {
          await mkdir(target, created);
        } catch (e) {
          const err = toIpcError(e);
          if (err.kind === "alreadyExists") {
            taken.add(name);
            continue;
          }
          failed("Could not create a folder", err);
          return;
        }
        selectOnly(pane, created);
        // A filter could hide the new folder (and its name field).
        patch(pane, { filter: "" });
        await get().refresh(pane);
        if (get().panes[pane].entries.some((e) => e.path === created)) {
          patch(pane, { editing: created });
        }
        return;
      }
      toastError("Could not create a folder", "Every name tried is taken.");
    },

    startRename: (pane, path) => {
      selectOnly(pane, path);
      patch(pane, { editing: path });
    },

    cancelRename: (pane) => patch(pane, { editing: null }),

    commitRename: async (pane, from, name) => {
      patch(pane, { editing: null });
      const { target } = get().panes[pane];
      const parent = parentPath(from);
      if (!target || parent === null || name === baseName(from)) return;
      const invalid = nameError(name);
      if (invalid) {
        toastError(`Could not rename ${baseName(from)}`, invalid);
        return;
      }
      const to = joinPath(parent, name);
      try {
        await renamePath(target, from, to);
      } catch (e) {
        failed(`Could not rename ${baseName(from)}`, toIpcError(e));
        return;
      }
      // Select the new name first, so the refresh keeps it selected.
      selectOnly(pane, to);
      await get().refresh(pane);
    },

    remove: async (pane, paths) => {
      const { target } = get().panes[pane];
      if (!target || paths.length === 0) return;
      let report: BatchReport;
      try {
        report = await deletePaths(target, paths);
      } catch (e) {
        failed(`Could not delete ${itemCount(paths.length)}`, toIpcError(e));
        await get().refresh(pane);
        return;
      }
      await get().refresh(pane);
      const done = report.succeeded.length;
      if (done > 0) {
        toastSuccess(
          target.kind === "local"
            ? `Moved ${itemCount(done)} to the ${TRASH_NAME}`
            : `Deleted ${itemCount(done)}`,
        );
      }
      reportFailures("delete", report);
    },

    chmod: async (pane, paths, mode, recursive) => {
      const { target } = get().panes[pane];
      if (!target || paths.length === 0) return;
      let report: BatchReport;
      try {
        report = await chmodPaths(target, paths, mode, recursive);
      } catch (e) {
        failed("Could not change permissions", toIpcError(e));
        return;
      }
      await get().refresh(pane);
      if (report.succeeded.length > 0) {
        toastSuccess(
          `Permissions set to ${formatOctalMode(mode)} on ${itemCount(report.succeeded.length)}`,
        );
      }
      reportFailures("change permissions of", report);
    },
  };
});

/** Toast a failed operation, except a lost session (the pane shows that). */
function failed(title: string, err: IpcError) {
  if (err.kind !== "notConnected") toastError(title, err.message);
}

/** One toast for a batch's failures: the first reason, and how many failed. */
function reportFailures(verb: string, report: BatchReport) {
  const first = report.failed[0];
  if (!first) return;
  const title =
    report.failed.length === 1
      ? `Could not ${verb} ${baseName(first.path)}`
      : `Could not ${verb} ${itemCount(report.failed.length)}`;
  toastError(title, first.message);
}
