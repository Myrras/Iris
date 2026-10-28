/**
 * "Download to…": pick a local folder with the native dialog, then queue a
 * normal download of remote items into it. Offered in the Remote pane's
 * context menu and whenever a drag out of the window cannot carry the
 * selection (too large, too slow).
 */

import { toIpcError } from "../ipc/commands";
import { usePaneStore } from "../state/paneStore";
import { toastError, toastInfo } from "../state/toastStore";
import { remoteSessionId, startTransfer } from "./transfer";

/** Ask for a folder and download `paths` into it; `false` when nothing was queued. */
export async function downloadTo(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  if (!remoteSessionId()) {
    toastInfo("Connect to a server to download");
    return false;
  }
  let picked: string | string[] | null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    picked = await open({
      directory: true,
      multiple: false,
      title: "Download to",
      defaultPath: usePaneStore.getState().panes.local.path ?? undefined,
    });
  } catch (e) {
    toastError("Could not open the folder picker", toIpcError(e).message);
    return false;
  }
  if (typeof picked !== "string") return false;
  return startTransfer("remote", paths, picked);
}
