/** Which files get the preview, and when the closed preview's handle shows. */
import type { Entry } from "../ipc/types";
import { isDirLike } from "./entries";

/** Whether `entry` has file contents to read. */
export function previewable(entry: Entry): boolean {
  if (isDirLike(entry)) return false;
  if (entry.kind.type === "other") return false;
  if (entry.kind.type === "symlink" && entry.kind.targetKind === null)
    return false;
  return true;
}

/** The pointer counts as "at the edge" within this many px of the window's right side. */
export const EDGE_REVEAL_PX = 8;
/** The handle lingers this long after the pointer leaves, so it can be caught. */
export const HANDLE_HIDE_DELAY_MS = 400;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "log",
  "csv",
  "tsv",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "lock",
  "gitignore",
  "service",
  "properties",
  "diff",
  "patch",
]);

/**
 * Cheap guess, from the listing only, whether `entry` has a preview. While the
 * island is closed this avoids a (remote) read on every selection: images
 * within the size cap, known text extensions, and extensionless or dot files
 * (README, Makefile, .env) count; empty files never do. The island itself
 * still decides by the real read, so a wrong guess only shows the handle.
 */
export function looksPreviewable(entry: Entry | null, maxBytes: number) {
  if (!entry || !previewable(entry)) return false;
  if (entry.size === 0) return false;
  const dot = entry.name.lastIndexOf(".");
  const ext = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return entry.size === null || entry.size <= maxBytes;
  if (ext === "") return true;
  return TEXT_EXTS.has(ext);
}
