/**
 * Path helpers for the breadcrumb and the Up button (the webview has no Node
 * `path`). Remote paths are POSIX; local ones may be Windows paths, so both
 * separators are understood and the one the path already uses is kept.
 */

export interface PathSegment {
  /** Label: a folder name, or the root itself (`/`, `C:\`). */
  name: string;
  /** Full path up to and including this segment. */
  path: string;
}

/** `C:\` / `C:/` style drive root at the start of a path. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;

/** Split `path` into the segments a breadcrumb shows, root first. */
export function pathSegments(path: string): PathSegment[] {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  let root = "";
  let rest = path;
  const drive = DRIVE_ROOT.exec(path);
  if (drive) {
    root = drive[0];
    rest = path.slice(root.length);
  } else if (path.startsWith("/")) {
    root = "/";
    rest = path.slice(1);
  }

  const segments: PathSegment[] = root ? [{ name: root, path: root }] : [];
  let acc = root;
  for (const name of rest.split(/[\\/]/).filter(Boolean)) {
    acc = acc === "" || acc === root ? `${acc}${name}` : `${acc}${sep}${name}`;
    segments.push({ name, path: acc });
  }
  return segments;
}

/** The folder one level up, or `null` at a root (or a bare relative name). */
export function parentPath(path: string): string | null {
  const segments = pathSegments(path);
  return segments.length > 1 ? segments[segments.length - 2].path : null;
}

/** The separator `path` uses: `\` for a pure Windows path, else `/`. */
function separatorOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** `name` inside the folder `parent`, with the folder's own separator. */
export function joinPath(parent: string, name: string): string {
  const sep = separatorOf(parent);
  return parent.endsWith("/") || parent.endsWith("\\")
    ? `${parent}${name}`
    : `${parent}${sep}${name}`;
}

/** The last segment of `path` (the root itself for a root). */
export function baseName(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1]?.name ?? path;
}

/**
 * The child of `ancestor` that `path` lies under (`path` itself when it is a
 * direct child), or `null` when `path` is not strictly below `ancestor`.
 * Case-sensitive, like every path comparison in the panes.
 */
export function childToward(ancestor: string, path: string): string | null {
  const a = pathSegments(ancestor);
  const p = pathSegments(path);
  if (p.length <= a.length) return null;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== p[i].path) return null;
  }
  return p[a.length].path;
}
