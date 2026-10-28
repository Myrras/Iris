import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
  mkdir: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  deletePaths: vi.fn(() => Promise.resolve({ succeeded: [], failed: [] })),
  chmod: vi.fn(() => Promise.resolve({ succeeded: [], failed: [] })),
  enqueueTransfers: vi.fn(() => Promise.resolve("b-1")),
  openRemote: vi.fn(() => Promise.resolve("e-1")),
  openLocal: vi.fn(() => Promise.resolve()),
  revealLocal: vi.fn(() => Promise.resolve()),
  listTransfers: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("../lib/connect", () => ({
  connectInTab: vi.fn(),
  retrySession: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../lib/tabs", () => ({ requestDisconnectSession: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve("/Users/alice/Downloads")),
}));

import {
  chmod,
  deletePaths,
  enqueueTransfers,
  listDir,
  mkdir,
  openLocal as openLocalIpc,
  openRemote,
  rename,
  revealLocal,
} from "../ipc/commands";
import type { ConnectionProfile, Entry, SessionState } from "../ipc/types";
import { connectInTab, retrySession } from "../lib/connect";
import { requestDisconnectSession } from "../lib/tabs";
import { useToastStore } from "../state/toastStore";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { useDragStore } from "../state/dragStore";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { useSyncStore } from "../state/syncStore";
import { useSettingsStore } from "../state/settingsStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { stubViewport } from "../test/viewport";
import { LocalIcon, ServerIcon } from "./icons";
import { Pane } from "./Pane";

stubViewport();

const alpha: ConnectionProfile = {
  id: "p-1",
  name: "Alpha",
  host: "alpha.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "password" },
  startDir: null,
  jump: null,
};

function entry(path: string, extra: Partial<Entry> = {}): Entry {
  const name = path.split("/").pop() ?? path;
  return {
    name,
    path,
    kind: { type: "file" },
    size: 10,
    mtime: null,
    mode: null,
    hidden: name.startsWith("."),
    ...extra,
  };
}

const HOME = [
  entry("/home/alice/docs", { kind: { type: "dir" } }),
  entry("/home/alice/.profile"),
  entry("/home/alice/notes.txt"),
  entry("/home/alice/todo.txt"),
];

const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("gridcell")[0].textContent);

beforeEach(() => {
  vi.clearAllMocks();
  resetTabs();
  useLayoutStore.getState().setPreviewOpen(false);
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  useSessionStore.setState({ sessions: {} });
  useProfilesStore.setState({ profiles: [alpha], loaded: true });
  useConnectionFormStore.setState({ open: false, editing: null });
  useSettingsStore.getState().set("browser", { showHidden: false });
  vi.mocked(listDir).mockImplementation(async (_t, path) =>
    path === "/home/alice" ? HOME : [entry(`${path}/inside.txt`)],
  );
});

async function openLocal() {
  render(<Pane id="local" title="Local" Icon={LocalIcon} />);
  await usePaneStore.getState().open("local", { kind: "local" }, null);
  await screen.findByText("notes.txt");
}

describe("Pane", () => {
  it("shows the welcome screen in the remote pane without a session", () => {
    render(<Pane id="remote" title="Remote" Icon={ServerIcon} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Connect to a server…" }),
    );
    expect(useConnectionFormStore.getState().open).toBe(true);
  });

  function showSession(state: SessionState) {
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state,
    });
    usePaneStore.setState((s) => ({
      panes: {
        ...s.panes,
        remote: {
          ...s.panes.remote,
          target: { kind: "remote", sessionId: "s-1" },
          path: "/srv",
          entries: [entry("/srv/report.pdf")],
        },
      },
    }));
  }

  it("shows a session the core gave up on, with Retry and Disconnect", () => {
    showSession({ status: "disconnected", reason: "connection lost" });
    render(<Pane id="remote" title="Remote" Icon={ServerIcon} />);
    expect(screen.getByText("Disconnected from Alpha")).toBeInTheDocument();
    expect(screen.getByText("connection lost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // The same session comes back: no new connect.
    expect(retrySession).toHaveBeenCalledWith("s-1");
    expect(connectInTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(requestDisconnectSession).toHaveBeenCalledWith("s-1");
  });

  it("keeps the listing under a reconnect banner that counts down", () => {
    vi.useFakeTimers();
    try {
      showSession({
        status: "reconnecting",
        attempt: 2,
        maxAttempts: 5,
        nextRetryInSecs: 2,
      });
      render(<Pane id="remote" title="Remote" Icon={ServerIcon} />);
      const banner = screen.getByRole("status");
      expect(banner).toHaveTextContent("reconnecting (attempt 2 of 5)");
      expect(banner).toHaveTextContent("Next try in 2s");
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
      expect(banner).toHaveTextContent("Next try in 1s");
      act(() => vi.advanceTimersByTime(1000));
      expect(banner).toHaveTextContent("Trying…");

      // The next attempt starts a fresh countdown.
      act(() =>
        useSessionStore.getState().apply({
          type: "sessionStateChanged",
          sessionId: "s-1",
          profileId: "p-1",
          state: {
            status: "reconnecting",
            attempt: 3,
            maxAttempts: 5,
            nextRetryInSecs: 4,
          },
        }),
      );
      expect(screen.getByRole("status")).toHaveTextContent("attempt 3 of 5");
      expect(screen.getByRole("status")).toHaveTextContent("Next try in 4s");

      fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
      expect(retrySession).toHaveBeenCalledWith("s-1");
      fireEvent.click(
        within(screen.getByRole("status")).getByRole("button", {
          name: "Disconnect",
        }),
      );
      expect(requestDisconnectSession).toHaveBeenCalledWith("s-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Reconnect in a restored tab without connecting by itself", () => {
    const tabId = useTabsStore.getState().activeTabId;
    useTabsStore.getState().update(tabId, {
      profileId: "p-1",
      title: "Alpha",
      pendingRemotePath: "/srv/www",
    });
    render(<Pane id="remote" title="Remote" Icon={ServerIcon} />);
    expect(screen.getByText("Alpha — not connected")).toBeInTheDocument();
    expect(screen.getByText(/opens \/srv\/www again/)).toBeInTheDocument();
    expect(connectInTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(connectInTab).toHaveBeenCalledWith(tabId, alpha);
  });

  it("lists the folder with folders first and hidden files hidden", async () => {
    await openLocal();
    expect(rowNames()).toEqual(["docs", "notes.txt", "todo.txt"]);
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent(
      "/homealice",
    );
  });

  it("toggles hidden files, starting from the setting", async () => {
    useSettingsStore.getState().set("browser", { showHidden: true });
    await openLocal();
    const toggle = screen.getByRole("button", { name: "Show hidden files" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(rowNames()).toContain(".profile");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(rowNames()).not.toContain(".profile");
  });

  it("filters by name", async () => {
    await openLocal();
    fireEvent.change(screen.getByLabelText("Filter Local files"), {
      target: { value: "TODO" },
    });
    expect(rowNames()).toEqual(["todo.txt"]);
    fireEvent.change(screen.getByLabelText("Filter Local files"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("sorts when a header is clicked", async () => {
    await openLocal();
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(rowNames()).toEqual(["docs", "todo.txt", "notes.txt"]);
  });

  it("multi-selects with Cmd and Shift", async () => {
    await openLocal();
    fireEvent.click(screen.getByText("docs"));
    fireEvent.click(screen.getByText("todo.txt"), { shiftKey: true });
    expect(usePaneStore.getState().panes.local.selection).toEqual([
      "/home/alice/docs",
      "/home/alice/notes.txt",
      "/home/alice/todo.txt",
    ]);
    fireEvent.click(screen.getByText("notes.txt"), { metaKey: true });
    expect(usePaneStore.getState().panes.local.selection).toEqual([
      "/home/alice/docs",
      "/home/alice/todo.txt",
    ]);
  });

  it("moves the selection with the arrow keys", async () => {
    await openLocal();
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    expect(usePaneStore.getState().panes.local.selection).toEqual([
      "/home/alice/docs",
      "/home/alice/notes.txt",
    ]);
  });

  it("opens a folder on double-click, then goes back and up", async () => {
    await openLocal();
    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeDisabled();

    fireEvent.doubleClick(screen.getByText("docs"));
    await screen.findByText("inside.txt");
    expect(back).toBeEnabled();

    fireEvent.click(back);
    await screen.findByText("notes.txt");

    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    await waitFor(() =>
      expect(usePaneStore.getState().panes.local.path).toBe("/home"),
    );
  });

  it("does not navigate into a file", async () => {
    await openLocal();
    fireEvent.doubleClick(screen.getByText("notes.txt"));
    expect(usePaneStore.getState().panes.local.path).toBe("/home/alice");
  });

  describe("file operations", () => {
    const grid = () => screen.getByRole("grid");
    const select = (name: string) => fireEvent.click(screen.getByText(name));

    it("creates a folder from the toolbar and renames it inline", async () => {
      await openLocal();
      fireEvent.click(screen.getByRole("button", { name: "New folder" }));
      await waitFor(() =>
        expect(mkdir).toHaveBeenCalledWith(
          { kind: "local" },
          "/home/alice/untitled folder",
        ),
      );
      // The listing now shows the new folder (the store re-reads it).
      vi.mocked(listDir).mockResolvedValue([
        ...HOME,
        entry("/home/alice/untitled folder", { kind: { type: "dir" } }),
      ]);
      await usePaneStore.getState().refresh("local");
      usePaneStore
        .getState()
        .startRename("local", "/home/alice/untitled folder");
      const input = await screen.findByLabelText("Rename untitled folder");
      fireEvent.change(input, { target: { value: "Reports" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(rename).toHaveBeenCalledWith(
          { kind: "local" },
          "/home/alice/untitled folder",
          "/home/alice/Reports",
        ),
      );
    });

    it("starts a new folder with Ctrl+Shift+N", async () => {
      await openLocal();
      fireEvent.keyDown(grid(), { key: "N", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(mkdir).toHaveBeenCalledTimes(1));
    });

    it("renames with F2 and cancels with Escape", async () => {
      await openLocal();
      select("notes.txt");
      fireEvent.keyDown(grid(), { key: "F2" });
      const input = await screen.findByLabelText("Rename notes.txt");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByLabelText("Rename notes.txt")).toBeNull();
      expect(usePaneStore.getState().panes.local.editing).toBeNull();
      expect(rename).not.toHaveBeenCalled();
    });

    it("confirms a delete with Delete and says where it goes", async () => {
      await openLocal();
      select("notes.txt");
      fireEvent.click(screen.getByText("todo.txt"), { metaKey: true });
      fireEvent.keyDown(grid(), { key: "Delete" });
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Move 2 items to the Trash?");
      expect(dialog).toHaveTextContent("notes.txt");
      expect(deletePaths).not.toHaveBeenCalled();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Move to Trash" }),
      );
      await waitFor(() =>
        expect(deletePaths).toHaveBeenCalledWith({ kind: "local" }, [
          "/home/alice/notes.txt",
          "/home/alice/todo.txt",
        ]),
      );
    });

    it("also deletes with Ctrl+Backspace, and Cancel deletes nothing", async () => {
      await openLocal();
      select("notes.txt");
      fireEvent.keyDown(grid(), { key: "Backspace", ctrlKey: true });
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(deletePaths).not.toHaveBeenCalled();
    });

    it("toggles the preview with Space", async () => {
      await openLocal();
      fireEvent.keyDown(grid(), { key: " " });
      expect(useLayoutStore.getState().previewOpen).toBe(true);
      fireEvent.keyDown(grid(), { key: " " });
      expect(useLayoutStore.getState().previewOpen).toBe(false);
      // The toolbar button does the same.
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      expect(useLayoutStore.getState().previewOpen).toBe(true);
    });

    it("does not treat typing in the filter as shortcuts", async () => {
      await openLocal();
      const filter = screen.getByLabelText("Filter Local files");
      fireEvent.keyDown(filter, { key: " " });
      fireEvent.keyDown(filter, { key: "Delete" });
      expect(useLayoutStore.getState().previewOpen).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("opens Get Info with Ctrl+I and applies a mode", async () => {
      vi.mocked(listDir).mockResolvedValue([
        entry("/home/alice/run.sh", { mode: 0o100644 }),
      ]);
      render(<Pane id="local" title="Local" Icon={LocalIcon} />);
      await usePaneStore.getState().open("local", { kind: "local" }, null);
      await screen.findByText("run.sh");
      select("run.sh");
      fireEvent.keyDown(grid(), { key: "i", ctrlKey: true });
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByLabelText("Owner execute"));
      fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
      await waitFor(() =>
        expect(chmod).toHaveBeenCalledWith(
          { kind: "local" },
          ["/home/alice/run.sh"],
          0o744,
          false,
        ),
      );
    });

    it("offers the file operations in the context menu", async () => {
      await openLocal();
      fireEvent.contextMenu(screen.getByText("docs"));
      // Right-clicking selects the row.
      expect(usePaneStore.getState().panes.local.selection).toEqual([
        "/home/alice/docs",
      ]);
      const labels = screen
        .getAllByRole("menuitem")
        .map((item) => item.firstChild?.textContent);
      expect(labels).toEqual([
        "Open",
        "Open With Default App",
        "Show in File Manager",
        "Preview",
        "Upload to Remote",
        "Sync Folders…",
        "New Folder",
        "Rename",
        "Get Info…",
        "Refresh",
        "Delete…",
      ]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
      expect(await screen.findByLabelText("Rename docs")).toBeInTheDocument();
    });

    it("offers New Folder and Refresh on the empty area", async () => {
      await openLocal();
      fireEvent.contextMenu(grid());
      expect(
        screen
          .getAllByRole("menuitem")
          .map((item) => item.firstChild?.textContent),
      ).toEqual([
        "New Folder",
        "Sync Folders…",
        "Show in File Manager",
        "Refresh",
      ]);
    });

    it("opens a local file on double-click and Enter; folders still navigate", async () => {
      await openLocal();
      fireEvent.doubleClick(screen.getByText("notes.txt"));
      await waitFor(() =>
        expect(vi.mocked(openLocalIpc)).toHaveBeenCalledWith(
          "/home/alice/notes.txt",
          false,
        ),
      );
      select("todo.txt");
      fireEvent.keyDown(grid(), { key: "Enter" });
      await waitFor(() =>
        expect(vi.mocked(openLocalIpc)).toHaveBeenCalledWith(
          "/home/alice/todo.txt",
          false,
        ),
      );
      expect(openRemote).not.toHaveBeenCalled();

      fireEvent.doubleClick(screen.getByText("docs"));
      await waitFor(() =>
        expect(usePaneStore.getState().panes.local.path).toBe(
          "/home/alice/docs",
        ),
      );
      expect(vi.mocked(openLocalIpc)).toHaveBeenCalledTimes(2);
    });

    it("opens the local selection with Ctrl+O and Ctrl+Down", async () => {
      await openLocal();
      select("notes.txt");
      fireEvent.keyDown(grid(), { key: "o", ctrlKey: true });
      await waitFor(() =>
        expect(vi.mocked(openLocalIpc)).toHaveBeenCalledWith(
          "/home/alice/notes.txt",
          false,
        ),
      );
    });

    it("toasts when the core cannot open the file", async () => {
      vi.mocked(openLocalIpc).mockRejectedValueOnce({
        kind: "config",
        message: "could not open the file: no application is set for its type",
      });
      await openLocal();
      fireEvent.doubleClick(screen.getByText("notes.txt"));
      await waitFor(() =>
        expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
          "Could not open notes.txt",
        ),
      );
    });

    it("offers Open, Open With Default App and Show in File Manager for local files", async () => {
      await openLocal();
      fireEvent.contextMenu(screen.getByText("notes.txt"));
      expect(screen.getByRole("menuitem", { name: "Open" })).toBeEnabled();
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Open With Default App" }),
      );
      await waitFor(() =>
        expect(vi.mocked(openLocalIpc)).toHaveBeenCalledWith(
          "/home/alice/notes.txt",
          true,
        ),
      );

      fireEvent.contextMenu(screen.getByText("notes.txt"));
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Show in File Manager" }),
      );
      await waitFor(() =>
        expect(revealLocal).toHaveBeenCalledWith("/home/alice/notes.txt"),
      );

      // A folder navigates; it has no default app.
      fireEvent.contextMenu(screen.getByText("docs"));
      expect(
        screen.getByRole("menuitem", { name: "Open With Default App" }),
      ).toBeDisabled();
    });

    it("reveals the selection with Ctrl+Alt+R, else the folder", async () => {
      await openLocal();
      select("notes.txt");
      fireEvent.keyDown(grid(), {
        key: "®",
        code: "KeyR",
        ctrlKey: true,
        altKey: true,
      });
      await waitFor(() =>
        expect(revealLocal).toHaveBeenCalledWith("/home/alice/notes.txt"),
      );
      // A plain Ctrl+R (or Alt+R) is not the shortcut.
      fireEvent.keyDown(grid(), { key: "r", code: "KeyR", ctrlKey: true });
      expect(revealLocal).toHaveBeenCalledTimes(1);

      // The background menu reveals the folder shown.
      fireEvent.contextMenu(grid());
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Show in File Manager" }),
      );
      await waitFor(() =>
        expect(revealLocal).toHaveBeenLastCalledWith("/home/alice"),
      );
    });

    it("calls a remote delete permanent", async () => {
      useSessionStore.getState().apply({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: { status: "connected" },
      });
      render(<Pane id="remote" title="Remote" Icon={ServerIcon} />);
      await usePaneStore
        .getState()
        .open("remote", { kind: "remote", sessionId: "s-1" }, null);
      await screen.findByText("notes.txt");
      select("notes.txt");
      fireEvent.keyDown(grid(), { key: "Delete" });
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Delete “notes.txt”?");
      expect(dialog).toHaveTextContent("permanently");
      expect(
        within(dialog).getByRole("button", { name: "Delete permanently" }),
      ).toHaveClass("danger");
    });
  });

  describe("transfers", () => {
    const SRV = [
      entry("/srv/www", { kind: { type: "dir" } }),
      entry("/srv/readme.md"),
    ];

    async function openBoth() {
      useSessionStore.getState().apply({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: { status: "connected" },
      });
      vi.mocked(listDir).mockImplementation(async (_t, path) =>
        path === "/home/alice" ? HOME : path === "/srv" ? SRV : [],
      );
      act(() => usePaneStore.getState().setActive("local"));
      render(
        <>
          <Pane id="local" title="Local" Icon={LocalIcon} />
          <Pane id="remote" title="Remote" Icon={ServerIcon} />
        </>,
      );
      await usePaneStore.getState().open("local", { kind: "local" }, null);
      await usePaneStore
        .getState()
        .open("remote", { kind: "remote", sessionId: "s-1" }, "/srv");
      await screen.findByText("readme.md");
    }

    const localPane = () => screen.getByRole("region", { name: "Local files" });
    const remotePane = () =>
      screen.getByRole("region", { name: "Remote files" });

    it("uploads the selection from the toolbar into the remote folder", async () => {
      await openBoth();
      const upload = within(localPane()).getByRole("button", {
        name: "Upload",
      });
      expect(upload).toBeDisabled();
      fireEvent.click(within(localPane()).getByText("notes.txt"));
      fireEvent.click(upload);
      await waitFor(() =>
        expect(enqueueTransfers).toHaveBeenCalledWith({
          sessionId: "s-1",
          direction: "upload",
          items: [{ src: "/home/alice/notes.txt" }],
          dstDir: "/srv",
        }),
      );
    });

    it("downloads with Ctrl+Shift+D and F5", async () => {
      await openBoth();
      fireEvent.click(within(remotePane()).getByText("readme.md"));
      const grid = within(remotePane()).getByRole("grid");
      fireEvent.keyDown(grid, { key: "D", ctrlKey: true, shiftKey: true });
      await waitFor(() =>
        expect(enqueueTransfers).toHaveBeenCalledWith({
          sessionId: "s-1",
          direction: "download",
          items: [{ src: "/srv/readme.md" }],
          dstDir: "/home/alice",
        }),
      );
      fireEvent.keyDown(grid, { key: "F5" });
      await waitFor(() => expect(enqueueTransfers).toHaveBeenCalledTimes(2));
      // Upload's shortcut does nothing in the remote pane.
      fireEvent.keyDown(grid, { key: "U", ctrlKey: true, shiftKey: true });
      expect(enqueueTransfers).toHaveBeenCalledTimes(2);
    });

    it("opens a remote file in the editor on double-click; folders still navigate", async () => {
      await openBoth();
      fireEvent.doubleClick(within(remotePane()).getByText("readme.md"));
      await waitFor(() =>
        expect(openRemote).toHaveBeenCalledWith("s-1", "/srv/readme.md"),
      );
      // A local file is not opened for editing.
      fireEvent.doubleClick(within(localPane()).getByText("notes.txt"));
      expect(openRemote).toHaveBeenCalledTimes(1);
      // ...and a remote one is never opened as a local path.
      expect(vi.mocked(openLocalIpc)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openLocalIpc)).toHaveBeenCalledWith(
        "/home/alice/notes.txt",
        false,
      );

      fireEvent.doubleClick(within(remotePane()).getByText("www"));
      await waitFor(() =>
        expect(usePaneStore.getState().panes.remote.path).toBe("/srv/www"),
      );
      expect(openRemote).toHaveBeenCalledTimes(1);
    });

    it("opens the remote selection in the editor with Ctrl+E", async () => {
      await openBoth();
      fireEvent.click(within(remotePane()).getByText("readme.md"));
      fireEvent.keyDown(within(remotePane()).getByRole("grid"), {
        key: "e",
        ctrlKey: true,
      });
      await waitFor(() =>
        expect(openRemote).toHaveBeenCalledWith("s-1", "/srv/readme.md"),
      );
      // Not on a folder, and not in the local pane.
      fireEvent.click(within(remotePane()).getByText("www"));
      fireEvent.keyDown(within(remotePane()).getByRole("grid"), {
        key: "e",
        ctrlKey: true,
      });
      fireEvent.click(within(localPane()).getByText("notes.txt"));
      fireEvent.keyDown(within(localPane()).getByRole("grid"), {
        key: "e",
        ctrlKey: true,
      });
      expect(openRemote).toHaveBeenCalledTimes(1);
    });

    it("does not reveal remote rows with Ctrl+Alt+R", async () => {
      await openBoth();
      fireEvent.click(within(remotePane()).getByText("readme.md"));
      fireEvent.keyDown(within(remotePane()).getByRole("grid"), {
        key: "®",
        code: "KeyR",
        ctrlKey: true,
        altKey: true,
      });
      expect(revealLocal).not.toHaveBeenCalled();
    });

    it("offers Open in Editor in the remote context menu only", async () => {
      await openBoth();
      fireEvent.contextMenu(within(remotePane()).getByText("readme.md"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Open in Editor" }));
      await waitFor(() =>
        expect(openRemote).toHaveBeenCalledWith("s-1", "/srv/readme.md"),
      );

      fireEvent.contextMenu(within(remotePane()).getByText("www"));
      expect(
        screen.getByRole("menuitem", { name: "Open in Editor" }),
      ).toBeDisabled();
      // Remote rows have no local-only entries.
      expect(
        screen.queryByRole("menuitem", { name: "Show in File Manager" }),
      ).toBeNull();
      expect(
        screen.queryByRole("menuitem", { name: "Open With Default App" }),
      ).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });

      fireEvent.contextMenu(within(localPane()).getByText("notes.txt"));
      await waitFor(() =>
        expect(
          screen.queryByRole("menuitem", { name: "Open in Editor" }),
        ).toBeNull(),
      );
    });

    it("downloads the remote selection to a picked folder", async () => {
      await openBoth();
      fireEvent.click(within(remotePane()).getByText("readme.md"));
      fireEvent.click(within(remotePane()).getByText("www"), { metaKey: true });
      fireEvent.contextMenu(within(remotePane()).getByText("www"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Download to…" }));
      await waitFor(() =>
        expect(enqueueTransfers).toHaveBeenCalledWith({
          sessionId: "s-1",
          direction: "download",
          // In listing order (folders first).
          items: [{ src: "/srv/www" }, { src: "/srv/readme.md" }],
          dstDir: "/Users/alice/Downloads",
        }),
      );
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.contextMenu(within(localPane()).getByText("notes.txt"));
      await waitFor(() =>
        expect(
          screen.queryByRole("menuitem", { name: "Download to…" }),
        ).toBeNull(),
      );
    });

    it("does not open for editing while the session reconnects", async () => {
      await openBoth();
      useSessionStore.getState().apply({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: {
          status: "reconnecting",
          attempt: 1,
          maxAttempts: 5,
          nextRetryInSecs: 1,
        },
      });
      fireEvent.doubleClick(await within(remotePane()).findByText("readme.md"));
      fireEvent.contextMenu(within(remotePane()).getByText("readme.md"));
      expect(
        screen.getByRole("menuitem", { name: "Open in Editor" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("menuitem", { name: "Download to…" }),
      ).toBeDisabled();
      expect(openRemote).not.toHaveBeenCalled();
    });

    it("opens the Sync dialog from the toolbar, the menu and Ctrl+Alt+S", async () => {
      await openBoth();
      const sync = within(localPane()).getByRole("button", {
        name: "Sync folders",
      });
      // No selection needed: it compares the folders.
      expect(sync).toBeEnabled();
      fireEvent.click(sync);
      expect(useSyncStore.getState().request?.direction).toBe("upload");

      act(() => useSyncStore.setState({ request: null }));
      const grid = within(remotePane()).getByRole("grid");
      fireEvent.keyDown(grid, {
        key: "ß",
        code: "KeyS",
        ctrlKey: true,
        altKey: true,
      });
      expect(useSyncStore.getState().request?.direction).toBe("download");

      act(() => useSyncStore.setState({ request: null }));
      fireEvent.contextMenu(within(remotePane()).getByText("readme.md"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Sync Folders…" }));
      expect(useSyncStore.getState().request?.direction).toBe("download");
    });

    it("disables Sync while the session reconnects", async () => {
      await openBoth();
      useSessionStore.getState().apply({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: {
          status: "reconnecting",
          attempt: 1,
          maxAttempts: 5,
          nextRetryInSecs: 1,
        },
      });
      await waitFor(() =>
        expect(
          within(localPane()).getByRole("button", { name: "Sync folders" }),
        ).toBeDisabled(),
      );
    });

    it("disables the transfer actions without a session", async () => {
      await openLocal();
      act(() => usePaneStore.getState().setActive("local"));
      fireEvent.click(screen.getByText("notes.txt"));
      expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
      fireEvent.contextMenu(screen.getByText("notes.txt"));
      expect(
        screen.getByRole("menuitem", { name: "Upload to Remote" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("menuitem", { name: "Sync Folders…" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Sync folders" }),
      ).toBeDisabled();
    });

    it("drags rows onto a folder in the other pane", async () => {
      await openBoth();
      const notes = within(localPane()).getByText("notes.txt");
      const www = within(remotePane()).getByText("www");

      fireEvent.mouseDown(notes, { button: 0, clientX: 10, clientY: 10 });
      // Below the threshold: still a click, no drag.
      fireEvent.mouseMove(notes, { clientX: 11, clientY: 11 });
      expect(useDragStore.getState().paneDrag).toBeNull();

      fireEvent.mouseMove(www, { clientX: 400, clientY: 40 });
      expect(useDragStore.getState().paneDrag).toMatchObject({
        from: "local",
        count: 1,
      });
      expect(remotePane()).toHaveAttribute("data-drop-target", "true");
      expect(www.closest('[role="row"]')).toHaveAttribute(
        "data-drop-target",
        "true",
      );
      // The pressed row became the selection.
      expect(usePaneStore.getState().panes.local.selection).toEqual([
        "/home/alice/notes.txt",
      ]);

      fireEvent.mouseUp(www, { clientX: 400, clientY: 40 });
      expect(useDragStore.getState().paneDrag).toBeNull();
      await waitFor(() =>
        expect(enqueueTransfers).toHaveBeenCalledWith({
          sessionId: "s-1",
          direction: "upload",
          items: [{ src: "/home/alice/notes.txt" }],
          dstDir: "/srv/www",
        }),
      );
    });

    it("ignores a drop on its own pane and cancels with Escape", async () => {
      await openBoth();
      const notes = within(localPane()).getByText("notes.txt");
      const docs = within(localPane()).getByText("docs");

      fireEvent.mouseDown(notes, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(docs, { clientX: 10, clientY: 80 });
      expect(localPane()).not.toHaveAttribute("data-drop-target");
      fireEvent.mouseUp(docs);
      expect(enqueueTransfers).not.toHaveBeenCalled();

      fireEvent.mouseDown(notes, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.mouseMove(remotePane(), { clientX: 400, clientY: 80 });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(useDragStore.getState().paneDrag).toBeNull();
      fireEvent.mouseUp(remotePane());
      expect(enqueueTransfers).not.toHaveBeenCalled();
    });

    it("shows the drop overlay while OS files hover the remote pane", async () => {
      await openBoth();
      act(() =>
        useDragStore
          .getState()
          .setNative(true, { pane: "remote", dir: "/srv/www" }),
      );
      expect(within(remotePane()).getByRole("status")).toHaveTextContent(
        "Drop to upload to www",
      );
      act(() => useDragStore.getState().end());
      expect(within(remotePane()).queryByRole("status")).toBeNull();
    });
  });

  describe("active pane", () => {
    async function openBoth() {
      act(() => usePaneStore.getState().setActive("local"));
      render(
        <>
          <Pane id="local" title="Local" Icon={LocalIcon} />
          <Pane id="remote" title="Remote" Icon={ServerIcon} />
        </>,
      );
      await usePaneStore.getState().open("local", { kind: "local" }, null);
      await screen.findByText("notes.txt");
    }
    const island = (name: string) =>
      screen.getByRole("region", { name: `${name} files` });
    const flags = () => [
      island("Local").getAttribute("data-active"),
      island("Remote").getAttribute("data-active"),
    ];

    it("follows clicks on rows, empty area, toolbar and keyboard focus", async () => {
      await openBoth();
      expect(flags()).toEqual(["true", "false"]);

      fireEvent.mouseDown(island("Remote"));
      expect(flags()).toEqual(["false", "true"]);

      fireEvent.mouseDown(screen.getByText("notes.txt"));
      expect(flags()).toEqual(["true", "false"]);

      fireEvent.mouseDown(
        screen.getByRole("button", { name: "Connect to a server…" }),
      );
      expect(flags()).toEqual(["false", "true"]);

      const toolbarBtn = within(island("Local")).getAllByRole("button")[0];
      fireEvent.mouseDown(toolbarBtn);
      expect(flags()).toEqual(["true", "false"]);

      act(() =>
        screen.getByRole("button", { name: "Connect to a server…" }).focus(),
      );
      expect(flags()).toEqual(["false", "true"]);
    });

    it("greys selected rows in the inactive pane only", async () => {
      await openBoth();
      act(() => usePaneStore.getState().setActive("local"));
      fireEvent.click(screen.getByText("notes.txt"));
      const row = () => screen.getByText("notes.txt").closest("[role=row]")!;
      expect(row()).toHaveAttribute("data-selected", "true");
      expect(row()).toHaveAttribute("data-pane-active", "true");
      act(() => usePaneStore.getState().setActive("remote"));
      expect(row()).toHaveAttribute("data-selected", "true");
      expect(row()).toHaveAttribute("data-pane-active", "false");
    });
  });
});
