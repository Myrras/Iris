/**
 * Opens the Sync dialog (`SyncDialog`, rendered once in `App`) from a
 * pane's toolbar, context menu or ⌥⌘S, with the direction that pane
 * suggests (Local → upload, Remote → download). Also reports a finished
 * run (`sync:finished`): a toast, and the tab's panes re-listed.
 */

import { create } from "zustand";

import type { SyncFinishedEvent, TransferDirection } from "../ipc/types";
import { finishedToast } from "../lib/sync";
import { refreshSessionPanes } from "../lib/tabs";
import { toastError, toastSuccess } from "./toastStore";

export interface SyncRequest {
  /** Distinguishes two openings in a row (the dialog starts over). */
  id: number;
  direction: TransferDirection;
}

interface SyncStoreState {
  request: SyncRequest | null;
  open: (direction: TransferDirection) => void;
  close: () => void;
}

let seq = 0;

export const useSyncStore = create<SyncStoreState>((set) => ({
  request: null,
  open: (direction) => {
    seq += 1;
    set({ request: { id: seq, direction } });
  },
  close: () => set({ request: null }),
}));

/** `sync:finished`: say how it went and show the result. */
export function syncFinished(event: SyncFinishedEvent): void {
  const [kind, title, detail] = finishedToast(event);
  if (kind === "success") toastSuccess(title);
  else toastError(title, detail);
  refreshSessionPanes(event.sessionId);
}
