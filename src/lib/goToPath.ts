/**
 * "Go to path": turn what the user typed into the pane's path bar into an
 * absolute path, and complete its last segment (Tab). Pure rules, no IPC: the
 * pane supplies the current folder, the home folder (only asked for when the
 * text starts with `~`) and the folder listings.
 *
 * Remote paths are always POSIX. Local ones follow the platform, so `windows`
 * is a parameter: backslashes, `C:\x`, `C:/x`, `C:x` (drive-relative) and
 * `\x` (rooted on the current drive) are understood there. UNC paths
 * (`\\server\share`) are not.
 */

export interface ResolveOptions {
  /** The folder on screen; relative paths start here. */
  cwd: string;
  /** The home folder, needed only when `usesHome(input)`. */
  home: string | null;
  /** Local path on Windows (else POSIX). */
  windows: boolean;
}

/** Trim whitespace and one pair of surrounding quotes (pasted paths). */
export function cleanInput(raw: string): string {
  let text = raw.trim();
  if (text.length >= 2) {
    const quote = text[0];
    if ((quote === '"' || quote === "'") && text.endsWith(quote)) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

/** Whether the text starts at the home folder (`~`, `~/x`; `~\x` on Windows). */
export function usesHome(raw: string, windows = false): boolean {
  const text = cleanInput(raw);
  return (
    text === "~" || text.startsWith("~/") || (windows && text.startsWith("~\\"))
  );
}

/** Resolve `.` and `..`; `..` at the root stays there. */
function collapse(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out;
}

function resolvePosix(
  text: string,
  cwd: string,
  home: string | null,
): string | null {
  let full: string;
  if (text === "~" || text.startsWith("~/")) {
    if (home === null) return null;
    full = `${home}/${text.slice(1)}`;
  } else if (text.startsWith("/")) {
    full = text;
  } else {
    full = `${cwd}/${text}`;
  }
  return `/${collapse(full.split("/")).join("/")}`;
}

const WIN_SEP = /[\\/]+/;
const WIN_DRIVE = /^([A-Za-z]):(.*)$/s;

/** `C:\Users\x` → drive `C`, segments; a path without a drive has `null`. */
function splitWindows(path: string): { drive: string | null; rest: string } {
  const match = WIN_DRIVE.exec(path);
  return match
    ? { drive: match[1].toUpperCase(), rest: match[2] }
    : { drive: null, rest: path };
}

function windowsPath(drive: string | null, segments: string[]): string {
  return `${drive ? `${drive}:` : ""}\\${segments.join("\\")}`;
}

function resolveWindows(
  text: string,
  cwd: string,
  home: string | null,
): string | null {
  let input = text;
  if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) {
    if (home === null) return null;
    input = `${home}\\${text.slice(1)}`;
  }
  const here = splitWindows(cwd);
  const typed = splitWindows(input);
  const rooted = /^[\\/]/.test(typed.rest);

  if (typed.drive !== null) {
    if (rooted) {
      return windowsPath(typed.drive, collapse(typed.rest.split(WIN_SEP)));
    }
    // `C:x` / `C:`: relative to the folder on screen when that is on C:,
    // else to C:'s root (the per-drive folder Windows would use is unknown).
    const base =
      typed.drive === here.drive ? collapse(here.rest.split(WIN_SEP)) : [];
    return windowsPath(
      typed.drive,
      collapse([...base, ...typed.rest.split(WIN_SEP)]),
    );
  }
  if (rooted) {
    return windowsPath(here.drive, collapse(input.split(WIN_SEP)));
  }
  return windowsPath(
    here.drive,
    collapse([...here.rest.split(WIN_SEP), ...input.split(WIN_SEP)]),
  );
}

/**
 * The absolute path `raw` points at, seen from `cwd`: `.` / `..` and repeated
 * slashes collapsed, no trailing slash (except a root). `null` for empty
 * text, or for `~` while `home` is unknown.
 */
export function resolveGoTo(raw: string, opts: ResolveOptions): string | null {
  const text = cleanInput(raw);
  if (text === "") return null;
  return opts.windows
    ? resolveWindows(text, opts.cwd, opts.home)
    : resolvePosix(text, opts.cwd, opts.home);
}

/** The inline message for a failed stat / listing. */
export function goToErrorMessage(kind: string, fallback: string): string {
  if (kind === "notFound") return "No such folder";
  if (kind === "permissionDenied") return "Permission denied";
  return fallback;
}

// -- Tab completion ----------------------------------------------------------

export interface CompletionSplit {
  /** Everything up to and including the last separator (`../sub/`). */
  head: string;
  /** The last segment typed so far (`do`). */
  prefix: string;
}

/**
 * Split the text at its last separator. `null` when completion does not
 * apply (the text is quoted).
 */
export function splitForCompletion(
  text: string,
  windows: boolean,
): CompletionSplit | null {
  const typed = text.trimStart();
  if (typed.startsWith('"') || typed.startsWith("'")) return null;
  const cut = windows
    ? Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\"))
    : typed.lastIndexOf("/");
  return { head: typed.slice(0, cut + 1), prefix: typed.slice(cut + 1) };
}

/** The folder whose listing completes `head` (the current folder for ``). */
export function completionFolder(
  head: string,
  opts: ResolveOptions,
): string | null {
  return resolveGoTo(head === "" ? "." : head, opts);
}

export interface Completion {
  /** The new field text. */
  text: string;
  /** Names to pick from; empty when the match was unique. */
  suggestions: string[];
}

const nfc = (s: string) => s.normalize("NFC");
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** The separator to append: the one `head` ends with, else the platform's. */
function separatorFor(head: string, windows: boolean): string {
  const last = head.slice(-1);
  if (last === "/" || last === "\\") return last;
  return windows ? "\\" : "/";
}

/**
 * Complete the last segment from the folder names listed in its folder.
 * Case-sensitive matches win; with none, case is ignored. One match is
 * completed with a trailing separator; several complete the common prefix and
 * are returned as suggestions. `null` when nothing matches.
 */
export function completeSegment(
  { head, prefix }: CompletionSplit,
  folders: string[],
  windows: boolean,
): Completion | null {
  const sep = separatorFor(head, windows);
  const want = nfc(prefix);
  let matches = folders.filter((n) => nfc(n).startsWith(want));
  if (matches.length === 0) {
    const lower = want.toLowerCase();
    matches = folders.filter((n) => nfc(n).toLowerCase().startsWith(lower));
  }
  if (matches.length === 0) {
    // `..` has no folder to match: take it as the parent folder.
    return prefix === ".."
      ? { text: `${head}..${sep}`, suggestions: [] }
      : null;
  }
  if (matches.length === 1) {
    return { text: `${head}${matches[0]}${sep}`, suggestions: [] };
  }
  const names = matches.map(nfc).sort((a, b) => collator.compare(a, b));
  let common = names[0];
  for (const name of names) {
    let i = 0;
    while (
      i < common.length &&
      i < name.length &&
      common[i].toLowerCase() === name[i].toLowerCase()
    ) {
      i += 1;
    }
    common = common.slice(0, i);
  }
  // Never shorten what was typed (case-insensitive matches keep its casing).
  const completed = common.length > want.length ? common : prefix;
  return { text: `${head}${completed}`, suggestions: names };
}

/** The text after picking `name` from the suggestions. */
export function pickSuggestion(
  split: CompletionSplit,
  name: string,
  windows: boolean,
): string {
  return `${split.head}${name}${separatorFor(split.head, windows)}`;
}
