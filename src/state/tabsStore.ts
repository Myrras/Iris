/**
 * The workspace tabs. Each tab is its own Local + Remote pane pair with, at
 * most, its own session: connecting a profile in a tab always opens a NEW
 * session for that tab, even when another tab shows the same profile, so
 * closing or reconnecting one tab never disturbs another.
 *
 * ## Pane state per tab
 * `paneStore` holds the panes of the ACTIVE tab (so every pane component and
 * action keeps working unchanged). The tabs in the background keep a
 * snapshot in `localPane` / `remotePane`; the active tab's snapshot is stale
 * until it is left. `switchTo` snapshots the panes on screen into the tab
 * being left, swaps the new tab's snapshot in (`paneStore.restore`, which
 * drops every request still in flight for the old tab) and re-lists both
 * panes, so a background tab never shows a stale folder for long.
 *
 * A pane that should open something the next time it is shown (a restored
 * folder, a session connected while its tab was in the background) records
 * it in `pendingLocalPath` / `pendingRemotePath`.
 *
 * ## Persistence
 * The open tabs (profile, title, both folders) and the active one are kept
 * in localStorage (`iris.tabs`). On start they are restored WITHOUT
 * connecting: a restored tab's remote pane offers "Reconnect" instead.
 * Connecting every tab at once would raise a burst of password, passphrase
 * and host key prompts before the user did anything, and open connections
 * they may not want any more; one click per tab keeps that in their hands.
 * The local pane reopens its saved folder right away.
 */

import { create } from "zustand";

import type { FsTarget, ProfileId, SessionId } from "../ipc/types";
import {
  initialPane,
  usePaneStore,
  type PaneId,
  type PaneState,
} from "./paneStore";

export type TabId = string;

export interface Tab {
  id: TabId;
  /** Shown when the tab has no profile; the profile's name otherwise. */
  title: string;
  /** The connection the tab is for (kept after a disconnect, for Connect). */
  profileId: ProfileId | null;
  /** The tab's own session; `null` before connecting or after a disconnect. */
  sessionId: SessionId | null;
  /**
   * A connect for this tab is under way (its session id is not known until
   * it succeeds, so the tab's dot cannot come from `sessionStore` yet).
   */
  connecting: boolean;
  /** Snapshots while the tab is in the background (stale while active). */
  localPane: PaneState;
  remotePane: PaneState;
  activePane: PaneId;
  /** Folder the local pane opens when next shown without a listing. */
  pendingLocalPath: string | null;
  /** Folder the remote pane opens when next shown without a listing. */
  pendingRemotePath: string | null;
}

/** A tab waiting for the user to confirm cutting its transfers short. */
export interface PendingTabAction {
  tabId: TabId;
  action: "close" | "disconnect";
}

export const NEW_TAB_TITLE = "New tab";
export const TABS_STORAGE_KEY = "iris.tabs";

/** What `iris.tabs` holds. */
interface PersistedTabs {
  tabs: {
    profileId: ProfileId | null;
    title: string;
    localPath: string | null;
    remotePath: string | null;
  }[];
  active: number;
}

let seq = 0;
const newId = (): TabId => `tab-${++seq}`;

function blankTab(patch: Partial<Tab> = {}): Tab {
  return {
    id: newId(),
    title: NEW_TAB_TITLE,
    profileId: null,
    sessionId: null,
    connecting: false,
    localPane: initialPane(),
    remotePane: initialPane(),
    activePane: "local",
    pendingLocalPath: null,
    pendingRemotePath: null,
    ...patch,
  };
}

/** The saved tabs, or one blank tab when there are none (or they are bad). */
export function loadTabs(): { tabs: Tab[]; activeTabId: TabId } {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<PersistedTabs>) : null;
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
      const str = (v: unknown) => (typeof v === "string" && v ? v : null);
      const tabs = saved.tabs.map((t) =>
        blankTab({
          profileId: str(t?.profileId),
          title: str(t?.title) ?? NEW_TAB_TITLE,
          pendingLocalPath: str(t?.localPath),
          pendingRemotePath: str(t?.profileId) ? str(t?.remotePath) : null,
        }),
      );
      const index =
        typeof saved.active === "number" &&
        saved.active >= 0 &&
        saved.active < tabs.length
          ? saved.active
          : 0;
      return { tabs, activeTabId: tabs[index].id };
    }
  } catch {
    /* unreadable: start fresh */
  }
  const tab = blankTab();
  return { tabs: [tab], activeTabId: tab.id };
}

let lastPersisted = "";

/** Save the tabs (the active one's folders come from `paneStore`). */
function persist(state: Pick<TabsState, "tabs" | "activeTabId">) {
  const { panes } = usePaneStore.getState();
  const doc: PersistedTabs = {
    tabs: state.tabs.map((tab) => {
      const active = tab.id === state.activeTabId;
      const local = active ? panes.local : tab.localPane;
      const remote = active ? panes.remote : tab.remotePane;
      return {
        profileId: tab.profileId,
        title: tab.title,
        localPath: local.path ?? tab.pendingLocalPath,
        remotePath: tab.profileId
          ? (remote.path ?? tab.pendingRemotePath)
          : null,
      };
    }),
    active: Math.max(
      0,
      state.tabs.findIndex((t) => t.id === state.activeTabId),
    ),
  };
  const json = JSON.stringify(doc);
  if (json === lastPersisted) return;
  lastPersisted = json;
  try {
    localStorage.setItem(TABS_STORAGE_KEY, json);
  } catch {
    /* quota exceeded */
  }
}

/** Re-list (or first open) the panes now on screen for `tab`. */
function showPanes(tab: Tab) {
  const panes = usePaneStore.getState();
  for (const id of ["local", "remote"] as const) {
    const pane = panes.panes[id];
    const pending =
      id === "local" ? tab.pendingLocalPath : tab.pendingRemotePath;
    const target: FsTarget | null =
      pane.target ?? (id === "local" ? { kind: "local" } : null);
    if (!target) continue;
    if (pane.path && pane.target) void panes.refresh(id);
    else void panes.open(id, target, pending);
  }
  // Spent once opened. A restored tab without a session keeps its remote
  // folder until Reconnect opens it.
  const spentRemote = tab.pendingRemotePath !== null && tab.sessionId !== null;
  if (tab.pendingLocalPath !== null || spentRemote) {
    useTabsStore.getState().update(tab.id, {
      pendingLocalPath: null,
      pendingRemotePath: spentRemote ? null : tab.pendingRemotePath,
    });
  }
}

interface TabsState {
  tabs: Tab[];
  activeTabId: TabId;
  /** Waiting for "close anyway" / "disconnect anyway" (see `lib/tabs`). */
  pending: PendingTabAction | null;

  /** Open the active tab's panes (once, at start). */
  showActive: () => void;
  /** Open a blank tab after the active one and switch to it. */
  newTab: () => TabId;
  switchTo: (id: TabId) => void;
  /** Switch by position (0-based); `-1` = the last tab. */
  switchToIndex: (index: number) => void;
  /** Next (`1`) or previous (`-1`) tab, wrapping around. */
  cycle: (step: 1 | -1) => void;
  /**
   * Drop a tab (its session is the caller's business: `lib/tabs`). The last
   * tab is replaced by a blank one, so there is always a tab.
   */
  removeTab: (id: TabId) => void;
  /** Move tab `from` to where `to` is (drag to reorder). */
  moveTab: (from: TabId, to: TabId) => void;
  update: (id: TabId, patch: Partial<Tab>) => void;
  /**
   * Show `sessionId` in tab `id`, opening `path` (or the home folder) — on
   * screen when the tab is active, else when it is next shown.
   */
  attachSession: (
    id: TabId,
    sessionId: SessionId,
    profileId: ProfileId,
    title: string,
    path: string | null,
  ) => void;
  /** The tab lets go of its session (user disconnect); the profile stays. */
  detachSession: (id: TabId) => void;
  /** Turn restored tabs of deleted profiles into blank tabs. */
  forgetMissingProfiles: (existing: ReadonlySet<ProfileId>) => void;
  setPending: (pending: PendingTabAction | null) => void;
}

export const useTabsStore = create<TabsState>((set, get) => {
  /** Save the panes on screen into the active tab's snapshot. */
  function snapshotActive(): Tab[] {
    const { panes, active } = usePaneStore.getState();
    const { tabs, activeTabId } = get();
    return tabs.map((t) =>
      t.id === activeTabId
        ? {
            ...t,
            localPane: panes.local,
            remotePane: panes.remote,
            activePane: active,
          }
        : t,
    );
  }

  /** Make `tab` the active one: swap its panes in and re-list them. */
  function activate(tabs: Tab[], tab: Tab) {
    set({ tabs, activeTabId: tab.id });
    usePaneStore
      .getState()
      .restore(
        { local: tab.localPane, remote: tab.remotePane },
        tab.activePane,
      );
    showPanes(tab);
  }

  return {
    ...loadTabs(),
    pending: null,

    showActive: () => {
      const tab = get().tabs.find((t) => t.id === get().activeTabId);
      if (tab) showPanes(tab);
    },

    newTab: () => {
      const tabs = snapshotActive();
      const tab = blankTab();
      const at = tabs.findIndex((t) => t.id === get().activeTabId);
      tabs.splice(at + 1, 0, tab);
      activate(tabs, tab);
      return tab.id;
    },

    switchTo: (id) => {
      if (id === get().activeTabId) return;
      const tabs = snapshotActive();
      const tab = tabs.find((t) => t.id === id);
      if (tab) activate(tabs, tab);
    },

    switchToIndex: (index) => {
      const { tabs } = get();
      const tab = index === -1 ? tabs[tabs.length - 1] : tabs[index];
      if (tab) get().switchTo(tab.id);
    },

    cycle: (step) => {
      const { tabs, activeTabId } = get();
      const at = tabs.findIndex((t) => t.id === activeTabId);
      const next = tabs[(at + step + tabs.length) % tabs.length];
      if (next) get().switchTo(next.id);
    },

    removeTab: (id) => {
      const { tabs, activeTabId } = get();
      const at = tabs.findIndex((t) => t.id === id);
      if (at < 0) return;
      const rest = tabs.filter((t) => t.id !== id);
      if (rest.length === 0) {
        const only = blankTab();
        activate([only], only);
        return;
      }
      if (id !== activeTabId) {
        set({ tabs: rest });
        return;
      }
      // The neighbour to the right takes its place, else the one left.
      const next = rest[Math.min(at, rest.length - 1)];
      activate(rest, next);
    },

    moveTab: (from, to) => {
      const tabs = [...get().tabs];
      const a = tabs.findIndex((t) => t.id === from);
      const b = tabs.findIndex((t) => t.id === to);
      if (a < 0 || b < 0 || a === b) return;
      const [moved] = tabs.splice(a, 1);
      tabs.splice(b, 0, moved);
      set({ tabs });
    },

    update: (id, patch) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      })),

    attachSession: (id, sessionId, profileId, title, path) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      const target: FsTarget = { kind: "remote", sessionId };
      if (id === get().activeTabId) {
        get().update(id, {
          sessionId,
          profileId,
          title,
          pendingRemotePath: null,
        });
        void usePaneStore.getState().open("remote", target, path);
        return;
      }
      const { sort, showHidden } = tab.remotePane;
      get().update(id, {
        sessionId,
        profileId,
        title,
        remotePane: { ...initialPane(), sort, showHidden, target },
        pendingRemotePath: path,
      });
    },

    detachSession: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      const active = id === get().activeTabId;
      const remote = active
        ? usePaneStore.getState().panes.remote
        : tab.remotePane;
      // Remember the folder, so Connect brings the user back to it.
      const pendingRemotePath = remote.path ?? tab.pendingRemotePath;
      if (active) {
        usePaneStore.getState().close("remote");
        get().update(id, { sessionId: null, pendingRemotePath });
      } else {
        const { sort, showHidden } = tab.remotePane;
        get().update(id, {
          sessionId: null,
          pendingRemotePath,
          remotePane: { ...initialPane(), sort, showHidden },
        });
      }
    },

    forgetMissingProfiles: (existing) =>
      set((s) => {
        let changed = false;
        const tabs = s.tabs.map((t) => {
          if (!t.profileId || t.sessionId || existing.has(t.profileId))
            return t;
          changed = true;
          return {
            ...t,
            profileId: null,
            title: NEW_TAB_TITLE,
            pendingRemotePath: null,
          };
        });
        return changed ? { tabs } : s;
      }),

    setPending: (pending) => set({ pending }),
  };
});

/** The tab on screen. */
export function activeTab(): Tab {
  const { tabs, activeTabId } = useTabsStore.getState();
  return tabs.find((t) => t.id === activeTabId) ?? tabs[0];
}

/** The tab holding `sessionId`, if any. */
export function tabOfSession(sessionId: SessionId): Tab | undefined {
  return useTabsStore.getState().tabs.find((t) => t.sessionId === sessionId);
}

/** Test helper: a fresh store state (one blank tab), ignoring localStorage. */
export function resetTabs(): void {
  const tab = blankTab();
  lastPersisted = "";
  useTabsStore.setState({ tabs: [tab], activeTabId: tab.id, pending: null });
}

// Persist on every tab change and every pane navigation (the active tab's
// folders live in paneStore). `persist` skips identical documents.
useTabsStore.subscribe((s) => persist(s));
usePaneStore.subscribe(() => persist(useTabsStore.getState()));
