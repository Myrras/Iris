/**
 * Dragging rows out of the window to Finder / Explorer.
 *
 * Inside the window a pane drag is mouse-based (`lib/paneDrag`, which says
 * why). When the pointer leaves the window, the drag is handed to the OS
 * through `@crabnebula/tauri-plugin-drag` (`startDrag`: NSDraggingSession on
 * macOS, DoDragDrop on Windows), which carries **files on disk** with copy
 * semantics:
 *
 * - Local rows go out as they are.
 * - Remote rows are downloaded first (`prepareRemoteDragOut` → the core's
 *   `prepare_drag_out`, into the app cache), while the ghost at the window
 *   edge shows the progress; the OS drag starts once they are there and the
 *   button is still held. A selection over the core's limits (200 MB / 500
 *   files), a preparation slower than `PREPARE_TIMEOUT_MS`, or a release
 *   before the files were ready offers "Download to…" instead.
 *
 * File promises (`NSFilePromiseProvider`, downloading only on drop) would
 * avoid the wait, but there is no mature cross-platform plugin for them; see
 * CLAUDE.md (Phase 7) for the comparison.
 */

import { startDrag } from "@crabnebula/tauri-plugin-drag";

import dragIcon from "../assets/drag-icon.png?inline";
import {
  cancelDragOut,
  finishDragOut,
  prepareDragOut,
  toIpcError,
} from "../ipc/commands";
import type { DragOutProgressEvent } from "../ipc/types";
import { useDragStore } from "../state/dragStore";
import type { PaneId } from "../state/paneStore";
import { toastError, useToastStore } from "../state/toastStore";
import { downloadTo } from "./downloadTo";

/** How long a drag waits for its remote files before offering "Download to…". */
export const PREPARE_TIMEOUT_MS = 20_000;

/**
 * Start the OS drag of local `paths` (copy); resolves whether something
 * took them (`false` for a cancelled drag or one that could not start).
 */
export function startNativeDrag(
  from: PaneId,
  paths: string[],
): Promise<boolean> {
  useDragStore.getState().setDragOut({ from, paths });
  return new Promise((resolve) => {
    // The Rust side reports `Dropped` or `Cancel` (the plugin's types say
    // `Cancelled`); anything but a drop is a cancel.
    startDrag({ item: paths, icon: dragIcon, mode: "copy" }, ({ result }) =>
      resolve(result === "Dropped"),
    ).catch((e) => {
      toastError("Could not drag the files out", toIpcError(e).message);
      resolve(false);
    });
  });
}

/** A download of remote rows for a drag out. */
export interface RemotePrep {
  id: string;
  /**
   * The local copies, or `null` when the drag cannot use them (cancelled,
   * failed, too large, too slow — the user was told where it matters).
   */
  done: Promise<string[] | null>;
  /** Stop it, or throw the prepared files away. Quiet; safe to repeat. */
  cancel: () => void;
}

/** The preparation whose progress the ghost shows. */
let current: string | null = null;

export function prepareRemoteDragOut(
  sessionId: string,
  paths: string[],
): RemotePrep {
  const id = crypto.randomUUID();
  current = id;
  let cancelled = false;
  let settled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    void cancelDragOut(id).catch(() => undefined);
  };
  const timer = setTimeout(() => {
    if (settled) return;
    cancel();
    offerDownloadTo(paths, "Preparing the drag took too long");
  }, PREPARE_TIMEOUT_MS);
  const done = prepareDragOut(id, sessionId, paths)
    .then(
      (ready) => (cancelled ? null : ready.paths),
      (e) => {
        const err = toIpcError(e);
        if (cancelled || err.kind === "cancelled") return null;
        if (err.kind === "tooLarge") {
          offerDownloadTo(paths, "Too large to drag out", err.message);
        } else {
          toastError("Could not prepare the drag", err.message);
        }
        return null;
      },
    )
    .finally(() => {
      settled = true;
      clearTimeout(timer);
      if (current === id) current = null;
    });
  return { id, done, cancel };
}

/** `dragOut:progress` from the core: show it on the ghost. */
export function dragOutProgress(event: DragOutProgressEvent): void {
  if (event.dragId !== current) return;
  useDragStore.getState().setPreparing({
    bytesDone: event.bytesDone,
    totalBytes: event.totalBytes,
  });
}

/** The OS drag of prepared remote files ended. */
export function finishRemoteDragOut(id: string, dropped: boolean): void {
  void finishDragOut(id, dropped).catch(() => undefined);
}

/** Offer "Download to…" for remote `paths` a drag could not carry. */
export function offerDownloadTo(
  paths: string[],
  message: string,
  detail = "Download them to a folder instead.",
): void {
  const toasts = useToastStore.getState();
  const id = toasts.push({
    kind: "info",
    message,
    detail,
    sticky: true,
    action: {
      label: "Download to…",
      onClick: () => {
        useToastStore.getState().requestDismiss(id);
        return downloadTo(paths).then(() => undefined);
      },
    },
  });
}
