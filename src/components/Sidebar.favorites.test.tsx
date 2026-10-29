/** Favorite folders in the sidebar: the Local section and per connection. */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ⌘-click means a new tab on macOS.
vi.mock("../lib/platform", () => ({ isMac: true, isWindows: false }));

// The "backend": favorites live here; the set_* calls store (or refuse).
const backend = vi.hoisted(() => ({
  localFavorites: [] as { path: string; label: string | null }[],
  profiles: [] as unknown[],
  fail: false,
}));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
  getSettings: vi.fn(() =>
    Promise.resolve({
      parallelTransfers: 4,
      reconnectAttempts: 5,
      editorOverrides: {},
      syncExcludes: [],
      localFavorites: backend.localFavorites,
    }),
  ),
  setLocalFavorites: vi.fn((favorites: typeof backend.localFavorites) => {
    if (backend.fail) {
      return Promise.reject({ kind: "invalidInput", message: "refused" });
    }
    backend.localFavorites = favorites;
    return Promise.resolve(favorites);
  }),
  listProfiles: vi.fn(() => Promise.resolve(backend.profiles)),
  setProfileFavorites: vi.fn(
    (profileId: string, favorites: typeof backend.localFavorites) => {
      if (backend.fail) {
        return Promise.reject({ kind: "invalidInput", message: "refused" });
      }
      backend.profiles = (backend.profiles as ConnectionProfile[]).map((p) =>
        p.id === profileId ? { ...p, favorites } : p,
      );
      return Promise.resolve(favorites);
    },
  ),
}));
// A connect that succeeds (attaches s-1) unless told to fail.
const connecting = vi.hoisted(() => ({ succeed: true }));
vi.mock("../lib/connect", async () => {
  const { useTabsStore } = await import("../state/tabsStore");
  return {
    disconnectSession: vi.fn(),
    openConnection: vi.fn(async (profile: ConnectionProfile) => {
      const tabs = useTabsStore.getState();
      tabs.activate(profile.id);
      if (tabs.connections[profile.id]?.sessionId) return;
      if (connecting.succeed) {
        useTabsStore
          .getState()
          .attachSession(profile.id, "s-1", profile.startDir);
      }
    }),
  };
});

import {
  listDir,
  setLocalFavorites,
  setProfileFavorites,
} from "../ipc/commands";
import type { ConnectionProfile, FsTarget } from "../ipc/types";
import { openConnection } from "../lib/connect";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { useToastStore } from "../state/toastStore";
import { Sidebar } from "./Sidebar";

const LOCAL: FsTarget = { kind: "local" };
const REMOTE: FsTarget = { kind: "remote", sessionId: "s-1" };

const prod: ConnectionProfile = {
  id: "p-1",
  name: "prod",
  host: "prod.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "agent" },
  startDir: "/srv",
  jump: null,
  favorites: [
    { path: "/var/www", label: null },
    { path: "/var/log/nginx", label: "nginx logs" },
  ],
};
const backup: ConnectionProfile = {
  ...prod,
  id: "p-2",
  name: "backup",
  favorites: [],
};

const ROW_H = 26;

/** jsdom has no layout: list items are 26px tall, stacked from the top. */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const index = this.parentElement
        ? Array.from(this.parentElement.children).indexOf(this)
        : 0;
      const top = this.getAttribute("role") === "listitem" ? index * ROW_H : 0;
      return {
        top,
        bottom: top + ROW_H,
        left: 0,
        right: 200,
        width: 200,
        height: ROW_H,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    },
  );
}

async function flush() {
  await act(() => new Promise((r) => setTimeout(r, 0)));
}

const panes = () => usePaneStore.getState().panes;

const localList = () => screen.getByRole("list", { name: "Local favorites" });
const prodList = () => screen.getByRole("list", { name: "Favorites of prod" });
const labels = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((li) => li.textContent);
const row = (list: HTMLElement, text: string) =>
  within(list).getByText(text).closest<HTMLElement>('[role="button"]')!;

/** Render with the Local pane open at home, like the app after start. */
async function renderSidebar() {
  useTabsStore.getState().start();
  render(<Sidebar />);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  backend.fail = false;
  backend.localFavorites = [
    { path: "/home/alice/projects", label: null },
    { path: "/home/alice/Downloads", label: "DL" },
    { path: "/home/alice/notes", label: null },
  ];
  backend.profiles = [prod, backup];
  connecting.succeed = true;
  resetTabs();
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
    active: "local",
  });
  useSessionStore.setState({ sessions: {} });
  useToastStore.setState({ toasts: [] });
  useBackendSettingsStore.setState({ settings: null });
  useProfilesStore.setState({ profiles: [prod, backup], loaded: true });
  useLayoutStore.setState({ collapsedFavorites: [] });
  stubLayout();
});

afterEach(async () => {
  vi.restoreAllMocks();
  fireEvent.mouseUp(window);
  delete document.documentElement.dataset.dragging;
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("the Local section", () => {
  it("lists Home first, then the Local favorites by name or label", async () => {
    await renderSidebar();
    const home = screen.getByRole("button", { name: "Home" });
    expect(home).toHaveAttribute("title", "/home/alice");
    await waitFor(() =>
      expect(labels(localList())).toEqual(["projects", "DL", "notes"]),
    );
    // The full path is the tooltip.
    expect(row(localList(), "DL")).toHaveAttribute(
      "title",
      "/home/alice/Downloads",
    );
    // Home cannot be renamed or removed.
    fireEvent.contextMenu(home);
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open", "Open in New Tab"]);
  });

  it("opens Home and a favorite in the active Local tab", async () => {
    await renderSidebar();
    await usePaneStore.getState().navigate("local", "/home/alice/elsewhere");
    fireEvent.click(await screen.findByText("projects"));
    await waitFor(() =>
      expect(panes().local.path).toBe("/home/alice/projects"),
    );
    // A navigation: Back returns to where the pane was.
    expect(panes().local.history).toContain("/home/alice/elsewhere");
    expect(useTabsStore.getState().local.tabs).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(panes().local.path).toBe("/home/alice"));
    expect(listDir).toHaveBeenLastCalledWith(LOCAL, "/home/alice");
  });

  it("opens a favorite in a new tab on ⌘-click", async () => {
    await renderSidebar();
    const first = useTabsStore.getState().local.activeTabId;
    fireEvent.click(await screen.findByText("DL"), { metaKey: true });
    await waitFor(() =>
      expect(panes().local.path).toBe("/home/alice/Downloads"),
    );
    const { tabs, activeTabId } = useTabsStore.getState().local;
    expect(tabs).toHaveLength(2);
    expect(activeTabId).not.toBe(first);
  });

  it("keeps a favorite whose folder is gone and says so", async () => {
    await renderSidebar();
    vi.mocked(listDir).mockImplementation(async (_t, path) => {
      if (path === "/home/alice/notes") {
        throw { kind: "notFound", message: "No such folder" };
      }
      return [];
    });
    fireEvent.click(await screen.findByText("notes"));
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toBe(
        "Could not open /home/alice/notes",
      ),
    );
    expect(panes().local.path).toBe("/home/alice");
    expect(setLocalFavorites).not.toHaveBeenCalled();
    expect(labels(localList())).toContain("notes");
  });

  it("renames a favorite inline; a blank label shows the folder's name again", async () => {
    await renderSidebar();
    fireEvent.contextMenu(await screen.findByText("projects"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Rename favorite /home/alice/projects");
    expect(field).toHaveValue("projects");
    fireEvent.change(field, { target: { value: "  Work  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(labels(localList())).toEqual(["Work", "DL", "notes"]),
    );
    // The path stays; only the label changes (trimmed by the core).
    expect(setLocalFavorites).toHaveBeenLastCalledWith([
      { path: "/home/alice/projects", label: "Work" },
      { path: "/home/alice/Downloads", label: "DL" },
      { path: "/home/alice/notes", label: null },
    ]);

    fireEvent.contextMenu(screen.getByText("DL"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const second = screen.getByLabelText(
      "Rename favorite /home/alice/Downloads",
    );
    fireEvent.change(second, { target: { value: "   " } });
    fireEvent.keyDown(second, { key: "Enter" });
    await waitFor(() =>
      expect(labels(localList())).toEqual(["Work", "Downloads", "notes"]),
    );

    // Escape leaves it as it was.
    fireEvent.contextMenu(screen.getByText("notes"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const third = screen.getByLabelText("Rename favorite /home/alice/notes");
    fireEvent.change(third, { target: { value: "Ideas" } });
    fireEvent.keyDown(third, { key: "Escape" });
    expect(setLocalFavorites).toHaveBeenCalledTimes(2);
    expect(labels(localList())).toEqual(["Work", "Downloads", "notes"]);
  });

  it("removes a favorite from its menu", async () => {
    await renderSidebar();
    fireEvent.contextMenu(await screen.findByText("DL"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from Favorites" }),
    );
    await waitFor(() =>
      expect(labels(localList())).toEqual(["projects", "notes"]),
    );
    expect(backend.localFavorites.map((f) => f.path)).toEqual([
      "/home/alice/projects",
      "/home/alice/notes",
    ]);
  });

  it("reorders by dragging and puts the backend's order back when refused", async () => {
    await renderSidebar();
    await screen.findByText("projects");
    /** Press `name`'s row, then move the pointer to each `y` in turn. */
    const drag = (name: string, ...ys: number[]) => {
      const from = labels(localList()).indexOf(name);
      fireEvent.mouseDown(row(localList(), name), {
        button: 0,
        clientX: 20,
        clientY: from * ROW_H + 13,
      });
      for (const y of ys) {
        fireEvent.mouseMove(window, { clientX: 20, clientY: y });
      }
      fireEvent.mouseUp(window);
    };

    // The first row to after the last.
    drag("projects", 20, 80);
    expect(labels(localList())).toEqual(["DL", "notes", "projects"]);
    await waitFor(() =>
      expect(backend.localFavorites.map((f) => f.path)).toEqual([
        "/home/alice/Downloads",
        "/home/alice/notes",
        "/home/alice/projects",
      ]),
    );
    await flush();

    backend.fail = true;
    // The last row to the top: sent, refused, and the backend's order is back.
    drag("projects", 30, 5);
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]).toMatchObject({
        message: "Could not reorder the favorites",
      }),
    );
    expect(setLocalFavorites).toHaveBeenLastCalledWith([
      { path: "/home/alice/projects", label: null },
      { path: "/home/alice/Downloads", label: "DL" },
      { path: "/home/alice/notes", label: null },
    ]);
    expect(labels(localList())).toEqual(["DL", "notes", "projects"]);
  });
});

describe("a connection's favorites", () => {
  it("lists them under the row with a disclosure that is remembered", async () => {
    await renderSidebar();
    expect(labels(prodList())).toEqual(["/var/www", "nginx logs"]);
    // Only a connection with favorites has a disclosure.
    expect(
      screen.queryByRole("button", { name: "Show favorites of backup" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Hide favorites of backup" }),
    ).not.toBeInTheDocument();

    const hide = screen.getByRole("button", { name: "Hide favorites of prod" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(hide);
    expect(
      screen.queryByRole("list", { name: "Favorites of prod" }),
    ).not.toBeInTheDocument();
    // The click folds the list; it does not open the connection.
    expect(openConnection).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().collapsedFavorites).toEqual(["p-1"]);
    expect(JSON.parse(localStorage.getItem("iris.layout")!)).toMatchObject({
      collapsedFavorites: ["p-1"],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Show favorites of prod" }),
    );
    expect(prodList()).toBeInTheDocument();
  });

  it("connects a disconnected connection, then opens the folder", async () => {
    await renderSidebar();
    fireEvent.click(row(prodList(), "/var/www"));
    await waitFor(() => expect(panes().remote.path).toBe("/var/www"));
    expect(openConnection).toHaveBeenCalledWith(prod);
    expect(useTabsStore.getState().activeProfileId).toBe("p-1");
    expect(panes().remote.target).toEqual(REMOTE);
    expect(listDir).toHaveBeenLastCalledWith(REMOTE, "/var/www");
    expect(usePaneStore.getState().active).toBe("remote");
  });

  it("navigates nowhere when the connect fails or is cancelled", async () => {
    connecting.succeed = false;
    await renderSidebar();
    fireEvent.click(row(prodList(), "/var/www"));
    await waitFor(() => expect(openConnection).toHaveBeenCalledWith(prod));
    await flush();
    expect(panes().remote.path).toBeNull();
    expect(listDir).not.toHaveBeenCalledWith(REMOTE, "/var/www");
    expect(vi.mocked(listDir).mock.calls.map(([, path]) => path)).toEqual([
      "/home/alice",
    ]);
  });

  it("opens the folder in a new Remote tab on ⌘-click", async () => {
    await renderSidebar();
    // Connected already, showing its start folder.
    useTabsStore.getState().activate("p-1");
    useTabsStore.getState().attachSession("p-1", "s-1", "/srv");
    await flush();
    expect(panes().remote.path).toBe("/srv");

    fireEvent.click(row(prodList(), "nginx logs"), { metaKey: true });
    await waitFor(() => expect(panes().remote.path).toBe("/var/log/nginx"));
    expect(useTabsStore.getState().connections["p-1"].remote.tabs).toHaveLength(
      2,
    );
    expect(listDir).toHaveBeenLastCalledWith(REMOTE, "/var/log/nginx");
  });

  it("renames and removes through the core", async () => {
    await renderSidebar();
    fireEvent.contextMenu(row(prodList(), "/var/www"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Rename favorite /var/www");
    // Remote favorites without a label show their whole path.
    expect(field).toHaveValue("/var/www");
    fireEvent.change(field, { target: { value: "site" } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(labels(prodList())).toEqual(["site", "nginx logs"]),
    );
    expect(setProfileFavorites).toHaveBeenLastCalledWith("p-1", [
      { path: "/var/www", label: "site" },
      { path: "/var/log/nginx", label: "nginx logs" },
    ]);

    fireEvent.contextMenu(row(prodList(), "nginx logs"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from Favorites" }),
    );
    await waitFor(() => expect(labels(prodList())).toEqual(["site"]));
    expect(setProfileFavorites).toHaveBeenLastCalledWith("p-1", [
      { path: "/var/www", label: "site" },
    ]);
  });

  it("puts a refused change back and says why", async () => {
    await renderSidebar();
    backend.fail = true;
    fireEvent.contextMenu(row(prodList(), "/var/www"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from Favorites" }),
    );
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]).toMatchObject({
        message: "Could not remove the favorite",
      }),
    );
    expect(labels(prodList())).toEqual(["/var/www", "nginx logs"]);
  });
});
