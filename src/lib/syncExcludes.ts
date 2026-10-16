/**
 * Rules of the Settings → Transfers "Sync excludes" list, mirroring
 * `normalize_excludes` in the core's `settings.rs`: one name pattern per
 * entry (`*` and `?` wildcards), no separators, no repeats.
 */

/** The core's defaults (`default_sync_excludes`). */
export const DEFAULT_SYNC_EXCLUDES = [
  ".git",
  ".DS_Store",
  "node_modules",
  "Thumbs.db",
];

/** `MAX_SYNC_EXCLUDES` / `MAX_SYNC_EXCLUDE_LEN` in the core. */
export const MAX_SYNC_EXCLUDES = 100;
export const MAX_SYNC_EXCLUDE_LEN = 255;

/** Why `pattern` cannot be added to `existing`, or `null`. */
export function excludeError(
  pattern: string,
  existing: string[],
): string | null {
  const p = pattern.trim();
  if (!p) return "Enter a name or pattern, e.g. *.log";
  if (/[/\\\0]/.test(p)) return "A pattern is one name: no / or \\.";
  if ([...p].length > MAX_SYNC_EXCLUDE_LEN)
    return `At most ${MAX_SYNC_EXCLUDE_LEN} characters.`;
  if (existing.includes(p)) return `“${p}” is already excluded.`;
  if (existing.length >= MAX_SYNC_EXCLUDES)
    return `At most ${MAX_SYNC_EXCLUDES} patterns.`;
  return null;
}

/** `existing` with `pattern` (trimmed) added at the end. */
export function withExclude(existing: string[], pattern: string): string[] {
  return [...existing, pattern.trim()];
}

/** `existing` without `pattern`. */
export function withoutExclude(existing: string[], pattern: string): string[] {
  return existing.filter((p) => p !== pattern);
}

/** Whether the list is the defaults, in order. */
export function isDefaultExcludes(list: string[]): boolean {
  return (
    list.length === DEFAULT_SYNC_EXCLUDES.length &&
    list.every((p, i) => p === DEFAULT_SYNC_EXCLUDES[i])
  );
}
