/**
 * Listing rules for the file panes: what counts as a folder, which entries
 * are shown (hidden toggle, filter box) and in what order. Pure functions over
 * the backend's `Entry` list, which arrives unsorted.
 */

import type { Entry } from "../ipc/types";

/** Columns the table can sort by. */
export type SortKey = "name" | "size" | "mtime" | "mode";
export type SortDir = "asc" | "desc";

export interface SortSpec {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortSpec = { key: "name", dir: "asc" };

/** A folder, or a symlink that resolves to one: both open on double-click. */
export function isDirLike(entry: Entry): boolean {
  return (
    entry.kind.type === "dir" ||
    (entry.kind.type === "symlink" && entry.kind.targetKind === "dir")
  );
}

// Natural ("file2" before "file10"), case- and accent-insensitive names.
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Unknown values (`null`) sort before every known one. */
function compareNullable(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

function compareBy(key: SortKey, a: Entry, b: Entry): number {
  switch (key) {
    case "name":
      return collator.compare(a.name, b.name);
    case "size":
      return a.size - b.size;
    case "mtime":
      return compareNullable(a.mtime, b.mtime);
    case "mode":
      // Compare the permission bits only, so the file type does not group.
      return compareNullable(
        a.mode === null ? null : a.mode & 0o7777,
        b.mode === null ? null : b.mode & 0o7777,
      );
  }
}

/**
 * A sorted copy: folders always first (in either direction), then by the
 * sort column, ties broken by name in the same direction.
 */
export function sortEntries(entries: Entry[], sort: SortSpec): Entry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    const dirA = isDirLike(a);
    if (dirA !== isDirLike(b)) return dirA ? -1 : 1;
    const primary = compareBy(sort.key, a, b);
    if (primary !== 0) return primary * sign;
    return collator.compare(a.name, b.name) * sign;
  });
}

export interface ViewOptions {
  showHidden: boolean;
  /** Case-insensitive substring of the name; blank shows everything. */
  filter: string;
  sort: SortSpec;
}

/** The entries a pane shows: hidden rule, then the filter box, then sorted. */
export function visibleEntries(entries: Entry[], opts: ViewOptions): Entry[] {
  const needle = opts.filter.trim().toLowerCase();
  const shown = entries.filter(
    (e) =>
      (opts.showHidden || !e.hidden) &&
      (needle === "" || e.name.toLowerCase().includes(needle)),
  );
  return sortEntries(shown, opts.sort);
}
