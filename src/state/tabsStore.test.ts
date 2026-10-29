import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  connect: vi.fn(),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));

import { connect, homeDir, listDir } from "../ipc/commands";
import type { Entry, FsTarget } from "../ipc/types";
import { initialPane, usePaneStore } from "./paneStore";
import {
  activeTabOf,
  connectionState,
  resetTabs,
  useTabsStore,
} from "./tabsStore";

const local: FsTarget = { kind: "local" };
const remote = (sessionId: string): FsTarget => ({ kind: "remote", sessionId });

const store = () => useTabsStore.getState();
const panes = () => usePaneStore.getState().panes;
const localTabs = () => store().local.tabs;
const remoteTabs = (profileId: string) =>
  store().connections[profileId]?.remote.tabs ?? [];

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

/** `profileId` connected as `sessionId` and shown in the Remote pane. */
async function connected(profileId: string, sessionId: string, dir = "/srv") {
  store().activate(profileId);
  store().attachSession(profileId, sessionId, dir);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
    active: "local",
  });
  resetTabs();
});

describe("tabsStore: start", () => {
  it("starts clean: one Local tab at home, no connection, nothing restored", async () => {
    // An old saved document from when tabs were persisted is ignored.
    localStorage.setItem(
      "iris.tabs",
      JSON.stringify({
        tabs: [{ profileId: "p-1", title: "Alpha", localPath: "/x" }],
        active: 0,
      }),
    );
    store().start();
    await flush();
    expect(localTabs()).toHaveLength(1);
    expect(store().connections).toEqual({});
    expect(store().activeProfileId).toBeNull();
    expect(homeDir).toHaveBeenCalledWith(local);
    expect(panes().local.path).toBe("/home/alice");
    expect(panes().remote.target).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(localStorage.getItem("iris.tabs")).toBeNull();
  });
});

describe("tabsStore: folder tabs", () => {
  beforeEach(async () => {
    store().start();
    await flush();
  });

  it("opens a new tab after the active one, on the same folder", async () => {
    await usePaneStore.getState().navigate("local", "/home/alice/docs");
    const first = store().local.activeTabId;
    const second = store().newTab("local");
    expect(store().local.activeTabId).toBe(second);
    await flush();
    expect(panes().local.path).toBe("/home/alice/docs");
    // A fresh tab: no Back history of its own.
    expect(panes().local.history).toEqual([]);
    store().switchTab("local", first);
    const third = store().newTab("local");
    expect(localTabs().map((t) => t.id)).toEqual([first, third, second]);
  });

  it("opens a new tab on a given folder (a favorite)", async () => {
    const first = store().local.activeTabId;
    store().newTab("local", "/home/alice/projects");
    await flush();
    expect(panes().local.path).toBe("/home/alice/projects");
    expect(listDir).toHaveBeenLastCalledWith(local, "/home/alice/projects");
    store().switchTab("local", first);
    await flush();
    expect(panes().local.path).toBe("/home/alice");
  });

  it("keeps each tab's own pane state when switching back and forth", async () => {
    const first = store().local.activeTabId;
    await usePaneStore.getState().navigate("local", "/home/alice/docs");
    usePaneStore.getState().setFilter("local", "rep");
    usePaneStore.getState().setSort("local", "size");
    usePaneStore.getState().setShowHidden("local", true);

    store().newTab("local");
    await flush();
    await usePaneStore.getState().navigate("local", "/tmp");
    expect(panes().local.filter).toBe("");

    vi.mocked(listDir).mockClear();
    store().switchTab("local", first);
    expect(panes().local).toMatchObject({
      path: "/home/alice/docs",
      history: ["/home/alice"],
      filter: "rep",
      sort: { key: "size", dir: "asc" },
      showHidden: true,
    });
    // Switching back re-lists the folder, so nothing stale stays up.
    expect(listDir).toHaveBeenCalledWith(local, "/home/alice/docs");
  });

  it("drops a listing still in flight for the tab that was left", async () => {
    const first = store().local.activeTabId;
    store().newTab("local");
    await flush();
    let answer: (entries: Entry[]) => void = () => undefined;
    vi.mocked(listDir).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const slow = usePaneStore.getState().navigate("local", "/slow");
    store().switchTab("local", first);
    answer([]);
    await slow;
    await flush();
    expect(panes().local.path).toBe("/home/alice");
  });

  it("switches by position, to the last one, and around", () => {
    const a = store().local.activeTabId;
    const b = store().newTab("local");
    const c = store().newTab("local");
    const active = () => store().local.activeTabId;
    store().switchTabIndex("local", 0);
    expect(active()).toBe(a);
    store().switchTabIndex("local", -1);
    expect(active()).toBe(c);
    store().switchTabIndex("local", 7); // no such tab: stays
    expect(active()).toBe(c);
    store().cycleTab("local", 1);
    expect(active()).toBe(a);
    store().cycleTab("local", -1);
    expect(active()).toBe(c);
    store().cycleTab("local", -1);
    expect(active()).toBe(b);
  });

  it("closing the active tab shows its right neighbour, else its left one", () => {
    const a = store().local.activeTabId;
    const b = store().newTab("local")!;
    const c = store().newTab("local")!;
    const active = () => store().local.activeTabId;
    store().switchTab("local", b);
    store().closeTab("local", b);
    expect(active()).toBe(c);
    store().closeTab("local", c);
    expect(active()).toBe(a);
    // A tab in the background goes without switching.
    const d = store().newTab("local")!;
    store().closeTab("local", a);
    expect(active()).toBe(d);
    expect(localTabs().map((t) => t.id)).toEqual([d]);
  });

  it("always keeps one tab per pane", () => {
    const only = store().local.activeTabId;
    store().closeTab("local", only);
    expect(localTabs().map((t) => t.id)).toEqual([only]);
  });

  it("has no remote tabs without an active connection", () => {
    expect(store().newTab("remote")).toBeNull();
    store().cycleTab("remote", 1);
    expect(panes().remote.target).toBeNull();
  });
});

describe("tabsStore: connections", () => {
  beforeEach(async () => {
    store().start();
    await flush();
  });

  it("shows a connection's session in its remote tab, at the start folder", async () => {
    await connected("p-1", "s-1", "/srv/www");
    expect(store().activeProfileId).toBe("p-1");
    expect(store().connections["p-1"]).toMatchObject({
      sessionId: "s-1",
      connecting: false,
    });
    expect(panes().remote).toMatchObject({
      target: remote("s-1"),
      path: "/srv/www",
    });
  });

  it("opens new remote tabs on the same session, never a new connection", async () => {
    await connected("p-1", "s-1");
    await usePaneStore.getState().navigate("remote", "/srv/logs");
    store().newTab("remote");
    await flush();
    expect(remoteTabs("p-1")).toHaveLength(2);
    expect(panes().remote).toMatchObject({
      target: remote("s-1"),
      path: "/srv/logs",
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("swaps in each connection's own remote tabs on a switch", async () => {
    await connected("p-1", "s-1");
    await usePaneStore.getState().navigate("remote", "/srv/a");
    store().newTab("remote");
    await flush();
    await usePaneStore.getState().navigate("remote", "/srv/b");

    await connected("p-2", "s-2", "/home/bob");
    expect(remoteTabs("p-2")).toHaveLength(1);
    expect(panes().remote).toMatchObject({
      target: remote("s-2"),
      path: "/home/bob",
    });

    vi.mocked(listDir).mockClear();
    store().activate("p-1");
    expect(store().connections["p-1"].remote.tabs).toHaveLength(2);
    expect(panes().remote).toMatchObject({
      target: remote("s-1"),
      path: "/srv/b",
    });
    expect(listDir).toHaveBeenCalledWith(remote("s-1"), "/srv/b");
    store().switchTab("remote", remoteTabs("p-1")[0].id);
    expect(panes().remote.path).toBe("/srv/a");
  });

  it("shares the Local tabs across connections", async () => {
    await usePaneStore.getState().navigate("local", "/home/alice/docs");
    store().newTab("local");
    await flush();
    await connected("p-1", "s-1");
    await connected("p-2", "s-2");
    expect(localTabs()).toHaveLength(2);
    expect(panes().local.path).toBe("/home/alice/docs");
    store().activate("p-1");
    expect(localTabs()).toHaveLength(2);
    expect(panes().local.path).toBe("/home/alice/docs");
  });

  it("keeps the active connection when another one connects in the background", async () => {
    await connected("p-1", "s-1");
    store().ensureConnection("p-2");
    store().attachSession("p-2", "s-2", "/home/bob");
    await flush();
    expect(store().activeProfileId).toBe("p-1");
    expect(panes().remote.target).toEqual(remote("s-1"));
    store().activate("p-2");
    await flush();
    expect(panes().remote).toMatchObject({
      target: remote("s-2"),
      path: "/home/bob",
    });
  });

  it("keeps the remote tabs on a disconnect and reopens their folders on reconnect", async () => {
    await connected("p-1", "s-1");
    await usePaneStore.getState().navigate("remote", "/srv/a");
    store().newTab("remote");
    await flush();
    await usePaneStore.getState().navigate("remote", "/srv/b");
    const ids = remoteTabs("p-1").map((t) => t.id);

    store().detachSession("p-1");
    expect(store().activeProfileId).toBe("p-1");
    expect(store().connections["p-1"].sessionId).toBeNull();
    expect(panes().remote.target).toBeNull();
    expect(remoteTabs("p-1").map((t) => t.id)).toEqual(ids);
    expect(remoteTabs("p-1").map((t) => t.pendingPath)).toEqual([
      "/srv/a",
      "/srv/b",
    ]);

    store().attachSession("p-1", "s-9", "/srv");
    await flush();
    expect(remoteTabs("p-1").map((t) => t.id)).toEqual(ids);
    expect(panes().remote).toMatchObject({
      target: remote("s-9"),
      path: "/srv/b",
    });
    store().switchTab("remote", ids[0]);
    await flush();
    expect(panes().remote).toMatchObject({
      target: remote("s-9"),
      path: "/srv/a",
    });
  });

  it("drops a connection and its tabs; the active one leaves the welcome screen", async () => {
    await connected("p-1", "s-1");
    store().dropConnection("p-1");
    expect(store().connections["p-1"]).toBeUndefined();
    expect(store().activeProfileId).toBeNull();
    expect(panes().remote.target).toBeNull();
  });

  it("reads a connection's state for its dot", () => {
    store().ensureConnection("p-1");
    const conn = () => store().connections["p-1"];
    expect(connectionState(conn(), {})).toBeUndefined();
    store().setConnecting("p-1", true);
    expect(connectionState(conn(), {})).toEqual({ status: "connecting" });
    store().attachSession("p-1", "s-1", null);
    // Up as soon as connect resolved, before the state event.
    expect(connectionState(conn(), {})).toEqual({ status: "connected" });
    const reconnecting = {
      status: "reconnecting",
      attempt: 1,
      maxAttempts: 5,
      nextRetryInSecs: 1,
    } as const;
    expect(
      connectionState(conn(), {
        "s-1": { sessionId: "s-1", profileId: "p-1", state: reconnecting },
      }),
    ).toEqual(reconnecting);
    expect(activeTabOf(conn().remote).pendingPath).toBeNull();
  });
});
