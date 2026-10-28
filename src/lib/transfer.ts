/**
 * Turning "copy these entries of one pane to the other" into a transfer
 * request: the Local pane uploads into the remote pane's folder, the Remote
 * pane downloads into the local pane's folder. Shared by the toolbar, the
 * context menu, the shortcuts and both kinds of drag and drop.
 */

import type { TransferRequest } from "../ipc/types";
import { usePaneStore, type PaneId } from "../state/paneStore";
import { useSessionStore } from "../state/sessionStore";
import { useTransferStore } from "../state/transferStore";

export function otherPane(pane: PaneId): PaneId {
  return pane === "local" ? "remote" : "local";
}

/**
 * The session the remote pane browses, or `null` while it is not connected
 * (connecting, reconnecting or down: a transfer queued then would only
 * fail with `notConnected`).
 */
export function remoteSessionId(): string | null {
  const target = usePaneStore.getState().panes.remote.target;
  if (target?.kind !== "remote") return null;
  const session = useSessionStore.getState().sessions[target.sessionId];
  // No state heard yet counts as usable: the pane only gets the target once
  // `connect` resolved, i.e. after the session was up.
  return session && session.state.status !== "connected"
    ? null
    : target.sessionId;
}

/**
 * The request that copies `items` from pane `from` into `dstDir` (by
 * default the other pane's folder); `null` when there is no session or no
 * destination folder yet.
 */
export function transferRequest(
  from: PaneId,
  items: string[],
  dstDir?: string | null,
): TransferRequest | null {
  const sessionId = remoteSessionId();
  const dir = dstDir ?? usePaneStore.getState().panes[otherPane(from)].path;
  if (!sessionId || !dir || items.length === 0) return null;
  return {
    sessionId,
    direction: from === "local" ? "upload" : "download",
    items: items.map((src) => ({ src })),
    dstDir: dir,
  };
}

/** Whether pane `from` can copy to the other one at all (session + folder). */
export function canTransfer(from: PaneId): boolean {
  const { panes } = usePaneStore.getState();
  return (
    remoteSessionId() !== null &&
    panes[from].path !== null &&
    panes[otherPane(from)].path !== null
  );
}

/** Queue the copy; resolves `false` when nothing was queued. */
export async function startTransfer(
  from: PaneId,
  items: string[],
  dstDir?: string | null,
): Promise<boolean> {
  const request = transferRequest(from, items, dstDir);
  if (!request) return false;
  return (await useTransferStore.getState().enqueue(request)) !== null;
}
