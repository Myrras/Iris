/**
 * What disconnecting or forgetting a connection does beyond the stores: the
 * backend disconnect (which cancels the session's unfinished transfers), and
 * the confirmation that guards it when there are any.
 *
 * - `requestDisconnect` / `requestDisconnectSession` act at once when the
 *   session has no unfinished transfers, else park the request in
 *   `tabsStore.pending` for `DisconnectModal` to confirm.
 * - Disconnecting keeps the connection and its remote tabs without a
 *   session, ready to Reconnect. Closing a remote tab never disconnects.
 * - A deleted profile's connection is dropped and its session closed.
 */

import { disconnect, toIpcError } from "../ipc/commands";
import type { ProfileId, SessionId } from "../ipc/types";
import { usePaneStore } from "../state/paneStore";
import {
  activeTabOf,
  connectionOfSession,
  useTabsStore,
} from "../state/tabsStore";
import { toastError } from "../state/toastStore";
import {
  countingBatches,
  unfinishedJobsOf,
  useTransferStore,
} from "../state/transferStore";

const connection = (profileId: ProfileId) =>
  useTabsStore.getState().connections[profileId];

/** Whether disconnecting `sessionId` would cut transfers short. */
export function hasUnfinishedTransfers(sessionId: SessionId | null): boolean {
  if (!sessionId) return false;
  const { jobs, batches } = useTransferStore.getState();
  return (
    unfinishedJobsOf(jobs, sessionId).length > 0 ||
    countingBatches(batches).some((b) => b.sessionId === sessionId)
  );
}

/** Disconnect in the backend; `false` (reported) when it refused. */
async function endSession(sessionId: SessionId): Promise<boolean> {
  try {
    await disconnect(sessionId);
    return true;
  } catch (e) {
    toastError("Could not disconnect", toIpcError(e).message);
    return false;
  }
}

/** Disconnect a connection, asking first when it still has transfers. */
export function requestDisconnect(profileId: ProfileId): void {
  const sessionId = connection(profileId)?.sessionId;
  if (!sessionId) return;
  if (hasUnfinishedTransfers(sessionId)) {
    useTabsStore.getState().setPending({ profileId });
  } else {
    void disconnectNow(profileId);
  }
}

/** Disconnect the connection holding `sessionId` (sidebar, pane). */
export function requestDisconnectSession(sessionId: SessionId): void {
  const conn = connectionOfSession(sessionId);
  if (conn) requestDisconnect(conn.profileId);
  else void endSession(sessionId);
}

/** Disconnect now; the connection keeps its tabs, ready to Reconnect. */
export async function disconnectNow(profileId: ProfileId): Promise<void> {
  const sessionId = connection(profileId)?.sessionId;
  if (!sessionId) return;
  if (await endSession(sessionId)) {
    // The connection may have moved on (deleted, connected anew) meanwhile.
    if (connection(profileId)?.sessionId === sessionId) {
      useTabsStore.getState().detachSession(profileId);
    }
  }
}

/** The user confirmed the parked disconnect. */
export async function confirmPending(): Promise<void> {
  const pending = useTabsStore.getState().pending;
  useTabsStore.getState().setPending(null);
  if (pending) await disconnectNow(pending.profileId);
}

/**
 * Drop the connections of deleted profiles: their tabs go, and a session
 * they still hold is closed (nothing would show it any more).
 */
export function forgetDeletedProfiles(existing: ReadonlySet<ProfileId>): void {
  for (const conn of Object.values(useTabsStore.getState().connections)) {
    if (existing.has(conn.profileId)) continue;
    useTabsStore.getState().dropConnection(conn.profileId);
    if (conn.sessionId) void endSession(conn.sessionId);
  }
}

/**
 * Something changed on `sessionId`'s server and the local disk (a reconnect,
 * a finished sync): re-list the Local pane, and the Remote pane when it shows
 * that session. Background tabs re-list when they are shown anyway.
 */
export function refreshSessionPanes(sessionId: SessionId): void {
  const panes = usePaneStore.getState();
  const conn = connectionOfSession(sessionId);
  const remote = panes.panes.remote;
  if (
    conn &&
    conn.profileId === useTabsStore.getState().activeProfileId &&
    remote.target?.kind === "remote" &&
    remote.target.sessionId === sessionId
  ) {
    if (remote.path) void panes.refresh("remote");
    else {
      void panes.open(
        "remote",
        remote.target,
        activeTabOf(conn.remote).pendingPath,
      );
    }
  }
  void panes.refresh("local");
}
