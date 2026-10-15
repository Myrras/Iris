import {
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
}));
vi.mock("../lib/connect", () => ({ connectProfile: vi.fn() }));

import { chmod, deletePaths, listDir, mkdir, rename } from "../ipc/commands";
import type { ConnectionProfile, Entry } from "../ipc/types";
import { connectProfile } from "../lib/connect";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { useSettingsStore } from "../state/settingsStore";
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

  it("shows a dropped session with Reconnect", () => {
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state: "disconnected",
      reason: "connection lost",
    });
    usePaneStore.setState((s) => ({
      panes: {
        ...s.panes,
        remote: {
          ...s.panes.remote,
          target: { kind: "remote", sessionId: "s-1" },
        },
      },
    }));
    render(<Pane id="remote" title="Remote" Icon={ServerIcon} />);
    expect(screen.getByText("Disconnected from Alpha")).toBeInTheDocument();
    expect(screen.getByText("connection lost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(connectProfile).toHaveBeenCalledWith(alpha);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(usePaneStore.getState().panes.remote.target).toBeNull();
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
        .map((item) => item.textContent);
      expect(labels).toEqual([
        "Open",
        "Preview",
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
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["New Folder", "Refresh"]);
    });

    it("calls a remote delete permanent", async () => {
      useSessionStore.getState().apply({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: "connected",
        reason: null,
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
});
