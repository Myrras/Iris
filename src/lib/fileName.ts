/**
 * Rules for names typed into the file panes (new folder, rename) and the
 * Finder-style defaults around them.
 */

/** The name a new folder starts with, as in Finder. */
export const NEW_FOLDER_NAME = "untitled folder";

/**
 * Why `name` cannot be used, or `null` when it can. Separators are refused on
 * both sides (`\` too, which Windows treats as one); `.` and `..` are never
 * entries.
 */
export function nameError(name: string): string | null {
  if (name.trim() === "") return "The name cannot be empty.";
  if (name === "." || name === "..") return `"${name}" is not a valid name.`;
  if (/[/\\]/.test(name)) return "The name cannot contain / or \\.";
  if (name.includes("\0")) return "The name contains an invalid character.";
  return null;
}

/**
 * `base`, or `base 2`, `base 3`, … — the first one not in `taken` (Finder's
 * numbering for "untitled folder").
 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The part of `name` selected when inline rename starts: the name without
 * its extension for files (`report` of `report.pdf`), everything for folders
 * and dotfiles.
 */
export function renameSelection(
  name: string,
  isDir: boolean,
): [start: number, end: number] {
  if (isDir) return [0, name.length];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [0, dot] : [0, name.length];
}
