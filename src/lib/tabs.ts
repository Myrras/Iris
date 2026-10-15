/**
 * What closing a tab or disconnecting its session does beyond the stores:
 * the backend disconnect (which cancels the session's unfinished
 * transfers), and the confirmation that guards it when there are any.
 *
 * - `requestCloseTab` / `requestDisconnect` act at once when the tab's
 *   session has no unfinished transfers, else park the request in
 *   `tabsStore.pending` for `TabCloseModal` to confirm.
 * - Closing a tab disconnects its session and drops the tab; disconnecting
 *   keeps the tab (and its profile, for "Connect") without a session.
 */

import { disconnect, toIpcError } from "../ipc/commands";
import type { SessionId } from "../ipc/types";
import { usePaneStore } from "../state/paneStore";
import { tabOfSession, useTabsStore, type TabId } from "../state/tabsStore";
import { toastError } from "../state/toastStore";
import { unfinishedJobsOf, useTransferStore } from "../state/transferStore";

function tab(id: TabId) {
  return useTabsStore.getState().tabs.find((t) => t.id === id);
}

/** Whether disconnecting `sessionId` would cut transfers short. */
export function hasUnfinishedTransfers(sessionId: SessionId | null): boolean {
  if (!sessionId) return false;
  return (
    unfinishedJobsOf(useTransferStore.getState().jobs, sessionId).length > 0
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

/** Close a tab, asking first when its session still has transfers. */
export function requestCloseTab(id: TabId): void {
  const t = tab(id);
  if (!t) return;
  if (hasUnfinishedTransfers(t.sessionId)) {
    useTabsStore.getState().setPending({ tabId: id, action: "close" });
  } else {
    void closeTabNow(id);
  }
}

/** Close the tab on screen (⌘W). */
export function requestCloseActiveTab(): void {
  requestCloseTab(useTabsStore.getState().activeTabId);
}

/** Disconnect a tab's session, asking first when it still has transfers. */
export function requestDisconnect(id: TabId): void {
  const t = tab(id);
  if (!t?.sessionId) return;
  if (hasUnfinishedTransfers(t.sessionId)) {
    useTabsStore.getState().setPending({ tabId: id, action: "disconnect" });
  } else {
    void disconnectTab(id);
  }
}

/** Disconnect the session shown in `sessionId`'s tab (sidebar, pane). */
export function requestDisconnectSession(sessionId: SessionId): void {
  const t = tabOfSession(sessionId);
  if (t) requestDisconnect(t.id);
  else void endSession(sessionId);
}

/** Close the tab now: disconnect its session, then drop the tab. */
export async function closeTabNow(id: TabId): Promise<void> {
  const t = tab(id);
  if (!t) return;
  // The tab goes either way: a session the backend could not close is
  // reported, and nothing shows it any more.
  useTabsStore.getState().removeTab(id);
  if (t.sessionId) await endSession(t.sessionId);
}

/** Disconnect the tab's session now; the tab stays, ready to Connect again. */
export async function disconnectTab(id: TabId): Promise<void> {
  const sessionId = tab(id)?.sessionId;
  if (!sessionId) return;
  if (await endSession(sessionId)) {
    // The tab may have moved on (closed, or connected anew) meanwhile.
    if (tab(id)?.sessionId === sessionId) {
      useTabsStore.getState().detachSession(id);
    }
  }
}

/** The user confirmed the parked close / disconnect. */
export async function confirmPending(): Promise<void> {
  const pending = useTabsStore.getState().pending;
  useTabsStore.getState().setPending(null);
  if (!pending) return;
  if (pending.action === "close") await closeTabNow(pending.tabId);
  else await disconnectTab(pending.tabId);
}

/**
 * The session's connection is back: re-list the panes of the tab showing
 * it. A tab in the background re-lists when it is switched to anyway.
 */
export function refreshSessionPanes(sessionId: SessionId): void {
  const t = tabOfSession(sessionId);
  if (!t || t.id !== useTabsStore.getState().activeTabId) return;
  const panes = usePaneStore.getState();
  const remote = panes.panes.remote;
  if (remote.path) void panes.refresh("remote");
  else void panes.open("remote", { kind: "remote", sessionId }, null);
  void panes.refresh("local");
}
