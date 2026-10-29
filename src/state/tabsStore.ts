/**
 * The folder tabs of both panes, and the connections the Remote pane shows.
 *
 * ## Connections
 * One session per saved connection (`Connection`, by profile id). The
 * sidebar picks the ACTIVE connection: the one the Remote pane shows. The
 * others keep running in the background (transfers, edits and the core's
 * reconnect go on) with their tabs waiting here. A user disconnect keeps the
 * connection and its tabs without a session (`sessionId: null`), so
 * Reconnect brings the same tabs back; deleting the profile drops it
 * (`lib/connections`).
 *
 * ## Folder tabs
 * The Local pane has one set of tabs for the whole app; the Remote pane one
 * set per connection, all on that connection's session (a tab never opens a
 * connection). Each tab is a pane state of its own: folder, Back history,
 * sort, filter, hidden toggle, selection.
 *
 * `paneStore` holds the tab ON SCREEN of each pane (the active Local tab and
 * the active connection's active Remote tab), so every pane component and
 * action keeps working unchanged. A tab in the background keeps a snapshot in
 * `pane`; the snapshot of the tab on screen is stale until it is left. A
 * switch (of tab or of connection) snapshots the pane into the tab being
 * left, swaps the new tab's snapshot in (`paneStore.restore`, which drops
 * every request still in flight for the old one) and re-lists it, so a
 * background tab never shows a stale folder for long.
 *
 * A tab without a listing opens `pendingPath` when shown (a new tab opens on
 * the folder of the tab it came from, a (re)connect reopens each remote tab's
 * folder or the profile's start folder), else the home folder.
 *
 * Nothing is kept across restarts: Iris starts with one Local tab at the home
 * folder and no connection.
 */

import { create } from "zustand";

import type {
  FsTarget,
  ProfileId,
  SessionId,
  SessionState,
} from "../ipc/types";
import {
  initialPane,
  usePaneStore,
  type PaneId,
  type PaneState,
} from "./paneStore";
import type { SessionInfo } from "./sessionStore";

export type TabId = string;

export interface FolderTab {
  id: TabId;
  /** The pane while the tab is in the background (stale while on screen). */
  pane: PaneState;
  /** Folder to open when the tab is shown without a listing. */
  pendingPath: string | null;
}

export interface TabSet {
  tabs: FolderTab[];
  activeTabId: TabId;
}

export interface Connection {
  profileId: ProfileId;
  /** Its one session; `null` before it connected or after a user disconnect. */
  sessionId: SessionId | null;
  /**
   * A connect is under way (its session id is not known until it succeeds,
   * so the dot cannot come from `sessionStore` yet).
   */
  connecting: boolean;
  /** The Remote pane's tabs for this connection. */
  remote: TabSet;
}

/** A disconnect waiting for the user to confirm cutting transfers short. */
export interface PendingDisconnect {
  profileId: ProfileId;
}

/** Where Iris once kept its tabs across restarts; cleared at start. */
const LEGACY_TABS_KEY = "iris.tabs";

const LOCAL: FsTarget = { kind: "local" };

let seq = 0;
const newId = (): TabId => `tab-${++seq}`;

function blankTab(
  pane: Partial<PaneState> = {},
  pendingPath: string | null = null,
): FolderTab {
  return { id: newId(), pane: { ...initialPane(), ...pane }, pendingPath };
}

function singleTabSet(): TabSet {
  const tab = blankTab();
  return { tabs: [tab], activeTabId: tab.id };
}

/** A pane's view preferences, carried over into a fresh pane state. */
const prefsOf = ({ sort, showHidden }: PaneState) => ({ sort, showHidden });

/** The active tab of a set. */
export function activeTabOf(set: TabSet): FolderTab {
  return set.tabs.find((t) => t.id === set.activeTabId) ?? set.tabs[0];
}

interface TabsState {
  /** The Local pane's tabs. */
  local: TabSet;
  /** By profile id; one per saved connection the user opened. */
  connections: Record<ProfileId, Connection>;
  /** The connection the Remote pane shows; `null` = the welcome screen. */
  activeProfileId: ProfileId | null;
  /** Waiting for "disconnect anyway" (see `lib/connections`). */
  pending: PendingDisconnect | null;

  /** Open the Local pane at the home folder (once, at start). */
  start: () => void;

  /**
   * Open a tab in `pane` after its active one, on `path` (a favorite) or
   * else the same folder, and show it. `null` when the pane has no tabs
   * (Remote without a connection).
   */
  newTab: (pane: PaneId, path?: string) => TabId | null;
  /** Close a tab of `pane`; a pane always keeps its last tab. */
  closeTab: (pane: PaneId, id: TabId) => void;
  switchTab: (pane: PaneId, id: TabId) => void;
  /** Switch by position (0-based); `-1` = the last tab. */
  switchTabIndex: (pane: PaneId, index: number) => void;
  /** Next (`1`) or previous (`-1`) tab of `pane`, wrapping around. */
  cycleTab: (pane: PaneId, step: 1 | -1) => void;

  /**
   * Show `profileId`'s connection in the Remote pane (creating it, with one
   * tab and no session, when there is none); `null` shows none.
   */
  activate: (profileId: ProfileId | null) => void;
  /** Make sure `profileId` has a connection (one tab, no session). */
  ensureConnection: (profileId: ProfileId) => void;
  setConnecting: (profileId: ProfileId, connecting: boolean) => void;
  /**
   * The connection got `sessionId`: every remote tab reopens its folder on
   * it (`startDir`, else home, for a tab that never had one).
   */
  attachSession: (
    profileId: ProfileId,
    sessionId: SessionId,
    startDir: string | null,
  ) => void;
  /** The connection lets go of its session (user disconnect); tabs stay. */
  detachSession: (profileId: ProfileId) => void;
  /** Forget a connection and its tabs (profile deleted, connect abandoned). */
  dropConnection: (profileId: ProfileId) => void;
  setPending: (pending: PendingDisconnect | null) => void;
}

/** The tab set `pane` shows: Local's, or the active connection's. */
export function tabSetOf(
  state: Pick<TabsState, "local" | "connections" | "activeProfileId">,
  pane: PaneId,
): TabSet | undefined {
  if (pane === "local") return state.local;
  return state.activeProfileId
    ? state.connections[state.activeProfileId]?.remote
    : undefined;
}

export const useTabsStore = create<TabsState>((set, get) => {
  /** `tabs` with the pane on screen saved into its active tab. */
  function snapshot(pane: PaneId, tabs: TabSet): TabSet {
    const current = usePaneStore.getState().panes[pane];
    return {
      ...tabs,
      tabs: tabs.tabs.map((t) =>
        t.id === tabs.activeTabId
          ? {
              ...t,
              pane: current,
              // Spent once the folder is on screen.
              pendingPath: current.path === null ? t.pendingPath : null,
            }
          : t,
      ),
    };
  }

  /** Put `tab` on screen in `pane` and list it. */
  function show(pane: PaneId, tab: FolderTab) {
    const panes = usePaneStore.getState();
    panes.restore(pane, tab.pane);
    const target = tab.pane.target ?? (pane === "local" ? LOCAL : null);
    // A connection without a session: the tab waits for one.
    if (!target) return;
    if (tab.pane.target && tab.pane.path) void panes.refresh(pane);
    else void panes.open(pane, target, tab.pendingPath);
  }

  /** Store `tabs` as the set `pane` shows. */
  function write(pane: PaneId, tabs: TabSet) {
    if (pane === "local") {
      set({ local: tabs });
      return;
    }
    const { activeProfileId, connections } = get();
    const conn = activeProfileId ? connections[activeProfileId] : undefined;
    if (!conn) return;
    set({
      connections: {
        ...connections,
        [conn.profileId]: { ...conn, remote: tabs },
      },
    });
  }

  function updateConnection(profileId: ProfileId, patch: Partial<Connection>) {
    const conn = get().connections[profileId];
    if (!conn) return;
    set({
      connections: { ...get().connections, [profileId]: { ...conn, ...patch } },
    });
  }

  /**
   * The connection's tabs, each reset to a fresh pane on `target` (`null` =
   * no session) that reopens its folder when shown.
   */
  function retarget(
    conn: Connection,
    target: FsTarget | null,
    fallback: string | null,
  ): TabSet {
    const active = get().activeProfileId === conn.profileId;
    const tabs = active ? snapshot("remote", conn.remote) : conn.remote;
    return {
      ...tabs,
      tabs: tabs.tabs.map((t) => ({
        id: t.id,
        pane: { ...initialPane(), ...prefsOf(t.pane), target },
        pendingPath: t.pane.path ?? t.pendingPath ?? fallback,
      })),
    };
  }

  return {
    local: singleTabSet(),
    connections: {},
    activeProfileId: null,
    pending: null,

    start: () => {
      // Tabs are no longer restored: an old saved document is just dropped.
      try {
        localStorage.removeItem(LEGACY_TABS_KEY);
      } catch {
        /* storage unavailable */
      }
      show("local", activeTabOf(get().local));
    },

    newTab: (pane, path) => {
      const tabs = tabSetOf(get(), pane);
      if (!tabs) return null;
      const saved = snapshot(pane, tabs);
      const from = activeTabOf(saved);
      const tab = blankTab(
        { ...prefsOf(from.pane), target: from.pane.target },
        path ?? from.pane.path ?? from.pendingPath,
      );
      const list = [...saved.tabs];
      list.splice(list.indexOf(from) + 1, 0, tab);
      write(pane, { tabs: list, activeTabId: tab.id });
      show(pane, tab);
      return tab.id;
    },

    closeTab: (pane, id) => {
      const tabs = tabSetOf(get(), pane);
      if (!tabs || tabs.tabs.length < 2) return;
      const at = tabs.tabs.findIndex((t) => t.id === id);
      if (at < 0) return;
      const rest = tabs.tabs.filter((t) => t.id !== id);
      if (id !== tabs.activeTabId) {
        write(pane, { ...tabs, tabs: rest });
        return;
      }
      // The neighbour to the right takes its place, else the one left.
      const next = rest[Math.min(at, rest.length - 1)];
      write(pane, { tabs: rest, activeTabId: next.id });
      show(pane, next);
    },

    switchTab: (pane, id) => {
      const tabs = tabSetOf(get(), pane);
      if (!tabs || id === tabs.activeTabId) return;
      const saved = snapshot(pane, tabs);
      const tab = saved.tabs.find((t) => t.id === id);
      if (!tab) return;
      write(pane, { ...saved, activeTabId: id });
      show(pane, tab);
    },

    switchTabIndex: (pane, index) => {
      const tabs = tabSetOf(get(), pane)?.tabs;
      const tab = tabs && (index === -1 ? tabs[tabs.length - 1] : tabs[index]);
      if (tab) get().switchTab(pane, tab.id);
    },

    cycleTab: (pane, step) => {
      const tabs = tabSetOf(get(), pane);
      if (!tabs) return;
      const at = tabs.tabs.findIndex((t) => t.id === tabs.activeTabId);
      const next = tabs.tabs[(at + step + tabs.tabs.length) % tabs.tabs.length];
      if (next) get().switchTab(pane, next.id);
    },

    activate: (profileId) => {
      const { activeProfileId, connections } = get();
      if (profileId === activeProfileId) return;
      let next = connections;
      const leaving = activeProfileId
        ? connections[activeProfileId]
        : undefined;
      if (leaving) {
        next = {
          ...next,
          [leaving.profileId]: {
            ...leaving,
            remote: snapshot("remote", leaving.remote),
          },
        };
      }
      if (profileId && !next[profileId]) {
        next = { ...next, [profileId]: newConnection(profileId) };
      }
      set({ connections: next, activeProfileId: profileId });
      if (profileId) show("remote", activeTabOf(next[profileId].remote));
      else usePaneStore.getState().close("remote");
    },

    ensureConnection: (profileId) => {
      if (get().connections[profileId]) return;
      set({
        connections: {
          ...get().connections,
          [profileId]: newConnection(profileId),
        },
      });
    },

    setConnecting: (profileId, connecting) =>
      updateConnection(profileId, { connecting }),

    attachSession: (profileId, sessionId, startDir) => {
      const conn = get().connections[profileId];
      if (!conn) return;
      const remote = retarget(conn, { kind: "remote", sessionId }, startDir);
      updateConnection(profileId, { sessionId, connecting: false, remote });
      if (get().activeProfileId === profileId) {
        show("remote", activeTabOf(remote));
      }
    },

    detachSession: (profileId) => {
      const conn = get().connections[profileId];
      if (!conn?.sessionId) return;
      // Each tab remembers its folder, so Reconnect brings the user back.
      const remote = retarget(conn, null, null);
      updateConnection(profileId, { sessionId: null, remote });
      if (get().activeProfileId === profileId) {
        show("remote", activeTabOf(remote));
      }
    },

    dropConnection: (profileId) => {
      const { connections, activeProfileId, pending } = get();
      if (!connections[profileId]) return;
      const rest = { ...connections };
      delete rest[profileId];
      const active = activeProfileId === profileId;
      set({
        connections: rest,
        activeProfileId: active ? null : activeProfileId,
        pending: pending?.profileId === profileId ? null : pending,
      });
      if (active) usePaneStore.getState().close("remote");
    },

    setPending: (pending) => set({ pending }),
  };
});

function newConnection(profileId: ProfileId): Connection {
  return {
    profileId,
    sessionId: null,
    connecting: false,
    remote: singleTabSet(),
  };
}

/** The connection the Remote pane shows, if any. */
export function activeConnection(): Connection | undefined {
  const { activeProfileId, connections } = useTabsStore.getState();
  return activeProfileId ? connections[activeProfileId] : undefined;
}

/** The connection holding `sessionId`, if any. */
export function connectionOfSession(
  sessionId: SessionId,
): Connection | undefined {
  return Object.values(useTabsStore.getState().connections).find(
    (c) => c.sessionId === sessionId,
  );
}

/**
 * What a connection's dot shows: its connect in progress, else its session's
 * state. A connection got its session once `connect` resolved, so it is up
 * even before the session's state event arrived.
 */
export function connectionState(
  conn: Connection | undefined,
  sessions: Record<SessionId, SessionInfo>,
): SessionState | undefined {
  if (!conn) return undefined;
  if (conn.connecting) return { status: "connecting" };
  if (!conn.sessionId) return undefined;
  return sessions[conn.sessionId]?.state ?? { status: "connected" };
}

/** Test helper: one blank Local tab, no connections. */
export function resetTabs(): void {
  useTabsStore.setState({
    local: singleTabSet(),
    connections: {},
    activeProfileId: null,
    pending: null,
  });
}
