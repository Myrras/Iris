/**
 * Multi-select rules for the file table, Finder-style: a plain click selects
 * one row, Cmd/Ctrl toggles a row, Shift selects the range from the anchor;
 * arrow keys move the cursor, Shift+arrow extends from the anchor. Rows are
 * identified by path; `paths` is the visible order.
 */

export interface SelectionState {
  selection: string[];
  /** Fixed end of a Shift range (the last plain or Cmd/Ctrl click). */
  anchor: string | null;
  /** The focused row (moves with the arrow keys). */
  cursor: string | null;
}

/** Inclusive range of `paths` between two paths, in visible order. */
function range(paths: string[], from: string, to: string): string[] {
  const a = paths.indexOf(from);
  const b = paths.indexOf(to);
  return paths.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The selection after clicking `path` with the given modifiers. */
export function clickSelection(
  current: Pick<SelectionState, "selection" | "anchor">,
  paths: string[],
  path: string,
  mods: { meta: boolean; shift: boolean },
): SelectionState {
  if (mods.meta) {
    const selection = current.selection.includes(path)
      ? current.selection.filter((p) => p !== path)
      : [...current.selection, path];
    return { selection, anchor: path, cursor: path };
  }
  if (mods.shift && current.anchor && paths.includes(current.anchor)) {
    return {
      selection: range(paths, current.anchor, path),
      anchor: current.anchor,
      cursor: path,
    };
  }
  return { selection: [path], anchor: path, cursor: path };
}

/** The selection after moving the cursor `delta` rows (Shift = `extend`). */
export function moveCursor(
  current: SelectionState,
  paths: string[],
  delta: number,
  extend: boolean,
): SelectionState {
  if (paths.length === 0) return current;
  const at = current.cursor ? paths.indexOf(current.cursor) : -1;
  const next =
    at === -1
      ? paths[0]
      : paths[Math.max(0, Math.min(paths.length - 1, at + delta))];
  if (extend && current.anchor && paths.includes(current.anchor)) {
    return {
      selection: range(paths, current.anchor, next),
      anchor: current.anchor,
      cursor: next,
    };
  }
  return { selection: [next], anchor: next, cursor: next };
}
