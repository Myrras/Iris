import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  connect: vi.fn(),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));

import { connect, homeDir, listDir } from "../ipc/commands";
import type { FsTarget } from "../ipc/types";
import { initialPane, usePaneStore } from "./paneStore";
import {
  NEW_TAB_TITLE,
  TABS_STORAGE_KEY,
  loadTabs,
  resetTabs,
  useTabsStore,
} from "./tabsStore";

const local: FsTarget = { kind: "local" };
const remote = (sessionId: string): FsTarget => ({ kind: "remote", sessionId });

const tabs = () => useTabsStore.getState().tabs;
const activeId = () => useTabsStore.getState().activeTabId;
const panes = () => usePaneStore.getState().panes;

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
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

describe("tabsStore", () => {
  it("starts with one blank tab", () => {
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]).toMatchObject({
      title: NEW_TAB_TITLE,
      profileId: null,
      sessionId: null,
    });
  });

  it("opens a new tab after the active one, with the local pane at home", async () => {
    const first = activeId();
    const second = useTabsStore.getState().newTab();
    expect(activeId()).toBe(second);
    useTabsStore.getState().switchTo(first);
    const third = useTabsStore.getState().newTab();
    expect(tabs().map((t) => t.id)).toEqual([first, third, second]);
    await flush();
    expect(homeDir).toHaveBeenCalledWith(local);
    expect(panes().local.path).toBe("/home/alice");
    expect(panes().remote.target).toBeNull();
  });

  it("keeps each tab's panes when switching back and forth", async () => {
    const first = activeId();
    await usePaneStore.getState().open("local", local, "/home/alice/docs");
    await usePaneStore.getState().open("remote", remote("s-1"), "/srv");
    usePaneStore.getState().setActive("remote");
    useTabsStore.getState().update(first, { sessionId: "s-1" });

    useTabsStore.getState().newTab();
    await flush();
    expect(panes().remote.target).toBeNull();
    expect(panes().local.path).toBe("/home/alice");
    expect(usePaneStore.getState().active).toBe("local");

    vi.mocked(listDir).mockClear();
    useTabsStore.getState().switchTo(first);
    expect(panes().local.path).toBe("/home/alice/docs");
    expect(panes().remote).toMatchObject({
      target: remote("s-1"),
      path: "/srv",
    });
    expect(usePaneStore.getState().active).toBe("remote");
    // Switching back re-lists both panes, so nothing stale stays up.
    expect(listDir).toHaveBeenCalledWith(remote("s-1"), "/srv");
    expect(listDir).toHaveBeenCalledWith(local, "/home/alice/docs");
  });

  it("switches by position, to the last one, and around", () => {
    const [a] = tabs().map((t) => t.id);
    const b = useTabsStore.getState().newTab();
    const c = useTabsStore.getState().newTab();
    useTabsStore.getState().switchToIndex(0);
    expect(activeId()).toBe(a);
    useTabsStore.getState().switchToIndex(-1);
    expect(activeId()).toBe(c);
    useTabsStore.getState().switchToIndex(7); // no such tab: stays
    expect(activeId()).toBe(c);
    useTabsStore.getState().cycle(1);
    expect(activeId()).toBe(a);
    useTabsStore.getState().cycle(-1);
    expect(activeId()).toBe(c);
    useTabsStore.getState().cycle(-1);
    expect(activeId()).toBe(b);
  });

  it("closing the active tab shows its right neighbour, else its left one", () => {
    const [a] = tabs().map((t) => t.id);
    const b = useTabsStore.getState().newTab();
    const c = useTabsStore.getState().newTab();
    useTabsStore.getState().switchTo(b);
    useTabsStore.getState().removeTab(b);
    expect(activeId()).toBe(c);
    useTabsStore.getState().removeTab(c);
    expect(activeId()).toBe(a);
    // A tab in the background goes without switching.
    const d = useTabsStore.getState().newTab();
    useTabsStore.getState().removeTab(a);
    expect(activeId()).toBe(d);
    expect(tabs().map((t) => t.id)).toEqual([d]);
  });

  it("always keeps a tab: closing the last one leaves a blank one", () => {
    const only = activeId();
    useTabsStore.getState().update(only, { profileId: "p-1", title: "Alpha" });
    useTabsStore.getState().removeTab(only);
    expect(tabs()).toHaveLength(1);
    expect(activeId()).not.toBe(only);
    expect(tabs()[0]).toMatchObject({ profileId: null, title: NEW_TAB_TITLE });
  });

  it("reorders by drag", () => {
    const [a] = tabs().map((t) => t.id);
    const b = useTabsStore.getState().newTab();
    const c = useTabsStore.getState().newTab();
    useTabsStore.getState().moveTab(c, a);
    expect(tabs().map((t) => t.id)).toEqual([c, a, b]);
  });

  it("opens a session attached to a background tab when it is shown", async () => {
    const first = activeId();
    useTabsStore.getState().newTab();
    useTabsStore
      .getState()
      .attachSession(first, "s-2", "p-1", "Alpha", "/srv/www");
    // Not on screen yet.
    expect(panes().remote.target).toBeNull();
    useTabsStore.getState().switchTo(first);
    await flush();
    expect(panes().remote).toMatchObject({
      target: remote("s-2"),
      path: "/srv/www",
    });
    expect(tabs()[0]).toMatchObject({
      sessionId: "s-2",
      title: "Alpha",
      pendingRemotePath: null,
    });
  });

  it("detaching a session keeps the profile and remembers the folder", async () => {
    const id = activeId();
    useTabsStore.getState().attachSession(id, "s-1", "p-1", "Alpha", "/srv");
    await flush();
    useTabsStore.getState().detachSession(id);
    expect(panes().remote.target).toBeNull();
    expect(tabs()[0]).toMatchObject({
      sessionId: null,
      profileId: "p-1",
      pendingRemotePath: "/srv",
    });
  });

  it("persists the tabs with their folders", async () => {
    const first = activeId();
    useTabsStore.getState().attachSession(first, "s-1", "p-1", "Alpha", "/srv");
    await usePaneStore.getState().open("local", local, "/home/alice/docs");
    await flush();
    useTabsStore.getState().newTab();
    await flush();
    const saved = JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) ?? "null");
    expect(saved).toEqual({
      tabs: [
        {
          profileId: "p-1",
          title: "Alpha",
          localPath: "/home/alice/docs",
          remotePath: "/srv",
        },
        {
          profileId: null,
          title: NEW_TAB_TITLE,
          localPath: "/home/alice",
          remotePath: null,
        },
      ],
      active: 1,
    });
  });

  it("restores saved tabs without connecting", async () => {
    localStorage.setItem(
      TABS_STORAGE_KEY,
      JSON.stringify({
        tabs: [
          {
            profileId: "p-1",
            title: "Alpha",
            localPath: "/home/alice/docs",
            remotePath: "/srv",
          },
          { profileId: null, title: "", localPath: null, remotePath: "/x" },
        ],
        active: 0,
      }),
    );
    const restored = loadTabs();
    expect(restored.tabs).toHaveLength(2);
    expect(restored.tabs[0]).toMatchObject({
      profileId: "p-1",
      title: "Alpha",
      sessionId: null,
      pendingLocalPath: "/home/alice/docs",
      pendingRemotePath: "/srv",
    });
    // A tab without a profile has no remote folder to remember.
    expect(restored.tabs[1]).toMatchObject({
      title: NEW_TAB_TITLE,
      pendingRemotePath: null,
    });
    expect(restored.activeTabId).toBe(restored.tabs[0].id);

    useTabsStore.setState(restored);
    useTabsStore.getState().showActive();
    await flush();
    expect(panes().local.path).toBe("/home/alice/docs");
    expect(panes().remote.target).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    // The remote folder waits for Reconnect.
    expect(tabs()[0].pendingRemotePath).toBe("/srv");
    expect(tabs()[0].pendingLocalPath).toBeNull();
  });

  it("starts fresh from a missing or broken document", () => {
    expect(loadTabs().tabs).toHaveLength(1);
    localStorage.setItem(TABS_STORAGE_KEY, "{not json");
    expect(loadTabs().tabs).toHaveLength(1);
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs: [] }));
    expect(loadTabs().tabs[0].title).toBe(NEW_TAB_TITLE);
  });

  it("turns restored tabs of deleted profiles into blank tabs", () => {
    const id = activeId();
    useTabsStore.getState().update(id, {
      profileId: "p-gone",
      title: "Gone",
      pendingRemotePath: "/srv",
    });
    const kept = useTabsStore.getState().newTab();
    useTabsStore.getState().update(kept, { profileId: "p-1", title: "Alpha" });
    useTabsStore.getState().forgetMissingProfiles(new Set(["p-1"]));
    expect(tabs()[0]).toMatchObject({
      profileId: null,
      title: NEW_TAB_TITLE,
      pendingRemotePath: null,
    });
    expect(tabs()[1]).toMatchObject({ profileId: "p-1", title: "Alpha" });
  });
});
