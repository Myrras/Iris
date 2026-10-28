/**
 * Local files from the Local pane: open one in its application (the one set
 * for its extension in Settings → Editors, else the OS default) and show one
 * in the file manager. Both are core commands; the webview has no opener
 * permission. Failures are toasted with the core's app-owned text.
 */

import { openLocal, revealLocal, toIpcError } from "../ipc/commands";
import { toastError } from "../state/toastStore";
import { baseName } from "./path";
import { isMac, isWindows } from "./platform";

/** What the OS calls its file manager. */
export const fileManagerName = isMac
  ? "Finder"
  : isWindows
    ? "Explorer"
    : "File Manager";

/** Paths being opened, so a double double-click opens once. */
const opening = new Set<string>();

/** Open the local file `path`; resolves `true` once the OS was asked to. */
export async function openLocalFile(
  path: string,
  useDefault = false,
): Promise<boolean> {
  if (opening.has(path)) return false;
  opening.add(path);
  try {
    await openLocal(path, useDefault);
    return true;
  } catch (e) {
    toastError(`Could not open ${baseName(path)}`, toIpcError(e).message);
    return false;
  } finally {
    opening.delete(path);
  }
}

/** Show the local file or folder `path` in the file manager. */
export async function revealLocalPath(path: string): Promise<boolean> {
  try {
    await revealLocal(path);
    return true;
  } catch (e) {
    toastError(
      `Could not show ${baseName(path) || path} in ${fileManagerName}`,
      toIpcError(e).message,
    );
    return false;
  }
}
