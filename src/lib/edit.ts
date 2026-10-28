/**
 * Remote edit from the panes: open a remote file in the local editor
 * (context menu, double-click, ⌘E) and react to what the core reports about
 * its saves (`edit:*` events, via `useCoreEvents`).
 *
 * The core downloads the file, opens it with the editor set for its
 * extension (Settings → Editors) or the OS default, and uploads each save.
 */

import { openRemote, toIpcError } from "../ipc/commands";
import type {
  EditFailedEvent,
  EditUploadedEvent,
  Entry,
  SessionId,
} from "../ipc/types";
import { usePaneStore } from "../state/paneStore";
import { toastError, toastSuccess } from "../state/toastStore";
import { baseName, parentPath } from "./path";

/** A plain file, or a link to one: what can be opened for editing. */
export function isEditable(entry: Entry): boolean {
  return (
    entry.kind.type === "file" ||
    (entry.kind.type === "symlink" && entry.kind.targetKind === "file")
  );
}

/** Paths being opened, so a double double-click opens once. */
const opening = new Set<string>();

/**
 * Open the remote file `path` of `sessionId` in its editor. Failures are
 * toasted; resolves `true` once the editor was asked to open it.
 */
export async function openForEdit(
  sessionId: SessionId,
  path: string,
): Promise<boolean> {
  const key = `${sessionId}:${path}`;
  if (opening.has(key)) return false;
  opening.add(key);
  try {
    await openRemote(sessionId, path);
    return true;
  } catch (e) {
    toastError(`Could not open ${baseName(path)}`, toIpcError(e).message);
    return false;
  } finally {
    opening.delete(key);
  }
}

/**
 * A save reached the server: say so, and re-list the Remote pane when it
 * shows that folder (a size, a date, or a new edited copy changed there).
 */
export function editUploaded(event: EditUploadedEvent): void {
  toastSuccess(`Uploaded ${baseName(event.path)}`);
  const panes = usePaneStore.getState();
  const remote = panes.panes.remote;
  if (
    remote.target?.kind === "remote" &&
    remote.target.sessionId === event.sessionId &&
    remote.path === parentPath(event.path)
  ) {
    void panes.refresh("remote");
  }
}

/** A save could not be uploaded; the next save tries again. */
export function editFailed(event: EditFailedEvent): void {
  toastError(
    `Could not upload ${baseName(event.path)}`,
    `${event.message}. Saving again retries.`,
  );
}
