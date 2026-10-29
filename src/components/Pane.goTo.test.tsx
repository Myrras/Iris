import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  stat: vi.fn(),
  homeDir: vi.fn(),
  listTransfers: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("../lib/connect", () => ({
  connectProfile: vi.fn(),
  retrySession: vi.fn(),
}));
vi.mock("../lib/connections", () => ({
  requestDisconnectSession: vi.fn(),
}));

import { homeDir, listDir, stat } from "../ipc/commands";
import type { Entry, EntryKind, IpcError } from "../ipc/types";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useSessionStore } from "../state/sessionStore";
import { useSettingsStore } from "../state/settingsStore";
import { useToastStore } from "../state/toastStore";
import { resetTabs } from "../state/tabsStore";
import { stubViewport } from "../test/viewport";
import { LocalIcon, ServerIcon } from "./icons";
import { Pane } from "./Pane";

stubViewport();

function entry(path: string, kind: EntryKind = { type: "file" }): Entry {
  const name = path.split("/").pop() ?? path;
  return {
    name,
    path,
    kind,
    size: 10,
    mtime: null,
    mode: null,
    hidden: name.startsWith("."),
  };
}
const dir = (path: string) => entry(path, { type: "dir" });

/** A tiny fake file system, the same for the local and the remote side. */
const TREE: Record<string, Entry[]> = {
  "/": [dir("/home"), dir("/srv"), dir("/locked")],
  "/home": [dir("/home/alice")],
  "/home/alice": [
    dir("/home/alice/docs"),
    dir("/home/alice/downloads"),
    dir("/home/alice/.config"),
    entry("/home/alice/notes.txt"),
    entry("/home/alice/zebra.txt"),
    entry("/home/alice/link-to-docs", {
      type: "symlink",
      target: "docs",
      targetKind: "dir",
    }),
  ],
  "/home/alice/docs": [entry("/home/alice/docs/a.txt")],
  "/home/alice/link-to-docs": [entry("/home/alice/link-to-docs/a.txt")],
  "/home/alice/downloads": [],
  "/srv": [dir("/srv/app"), dir("/srv/home")],
  "/srv/app": [entry("/srv/app/index.html")],
  "/srv/home": [entry("/srv/home/readme.md")],
  "/locked": [],
};
const PERMISSION_DENIED = new Set(["/locked"]);

function ipcError(kind: string, message = kind): IpcError {
  return { kind, message };
}

function find(path: string): Entry | undefined {
  if (path === "/") return dir("/");
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  return TREE[parent]?.find((e) => e.path === path);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTabs();
  useLayoutStore.getState().setPreviewOpen(false);
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  useSessionStore.setState({ sessions: {} });
  useToastStore.setState({ toasts: [] });
  useSettingsStore.getState().set("browser", { showHidden: false });
  vi.mocked(homeDir).mockImplementation(async (t) =>
    t.kind === "local" ? "/home/alice" : "/srv/home",
  );
  vi.mocked(listDir).mockImplementation(async (_t, path) => {
    if (PERMISSION_DENIED.has(path)) throw ipcError("permissionDenied");
    const list = TREE[path];
    if (!list) throw ipcError("notFound");
    return list;
  });
  vi.mocked(stat).mockImplementation(async (_t, path) => {
    const found = find(path);
    if (!found) throw ipcError("notFound");
    return found;
  });
});
afterEach(() => vi.restoreAllMocks());

const local = () => usePaneStore.getState().panes.local;
const remote = () => usePaneStore.getState().panes.remote;
const grid = () => screen.getByRole("grid");
const field = () => screen.getByRole("textbox", { name: "Go to path" });
const queryField = () => screen.queryByRole("textbox", { name: "Go to path" });

async function openLocal(path = "/home/alice") {
  render(<Pane id="local" title="Local" Icon={LocalIcon} />);
  await usePaneStore.getState().open("local", { kind: "local" }, path);
  await screen.findByRole("grid");
}

async function openRemote(status: "connected" | "reconnecting" = "connected") {
  useSessionStore.getState().apply({
    type: "sessionStateChanged",
    sessionId: "s-1",
    profileId: "p-1",
    state:
      status === "connected"
        ? { status: "connected" }
        : { status, attempt: 1, maxAttempts: 5, nextRetryInSecs: 3 },
  });
  render(<Pane id="remote" title="Remote" Icon={ServerIcon} />);
  await usePaneStore
    .getState()
    .open("remote", { kind: "remote", sessionId: "s-1" }, "/srv/app");
  await screen.findByRole("grid");
}

const openByShortcut = () =>
  fireEvent.keyDown(grid(), { key: "p", ctrlKey: true });

/** Type `text` and press Enter, then wait for the folder to change. */
async function goTo(text: string) {
  openByShortcut();
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.keyDown(field(), { key: "Enter" });
}

describe("opening the field", () => {
  it("opens with Ctrl+P, prefilled with the path and selected", async () => {
    await openLocal();
    expect(queryField()).toBeNull();
    openByShortcut();
    const input = field() as HTMLInputElement;
    expect(input.value).toBe("/home/alice");
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("/home/alice".length);
    // The breadcrumb makes room for it.
    expect(screen.queryByRole("navigation", { name: "Path" })).toBeNull();
  });

  it("opens with Ctrl+L", async () => {
    await openLocal();
    fireEvent.keyDown(grid(), { key: "l", ctrlKey: true });
    expect(field()).toBeInTheDocument();
  });

  it("opens with a click on the empty part of the breadcrumb bar", async () => {
    await openLocal();
    const nav = screen.getByRole("navigation", { name: "Path" });
    // A segment still navigates instead.
    fireEvent.click(screen.getByRole("button", { name: "home" }));
    await waitFor(() => expect(local().path).toBe("/home"));
    expect(queryField()).toBeNull();
    fireEvent.click(nav);
    expect(field()).toHaveValue("/home");
  });

  it("opens with a double-click on the breadcrumb", async () => {
    await openLocal();
    fireEvent.doubleClick(
      within(screen.getByRole("navigation", { name: "Path" })).getByText(
        "alice",
      ),
    );
    expect(field()).toHaveValue("/home/alice");
  });

  it("does not open from other combinations", async () => {
    await openLocal();
    fireEvent.keyDown(grid(), { key: "l", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(grid(), { key: "g", ctrlKey: true });
    // Ctrl+Shift+G was the old default: it is not bound any more.
    fireEvent.keyDown(grid(), { key: "G", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(grid(), { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(grid(), { key: "l", altKey: true, ctrlKey: true });
    expect(queryField()).toBeNull();
  });

  it("closes on Escape and gives the focus back to the table", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "/somewhere" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(queryField()).toBeNull();
    expect(screen.getByRole("navigation", { name: "Path" })).toHaveTextContent(
      "alice",
    );
    expect(grid()).toHaveFocus();
    expect(local().path).toBe("/home/alice");
    // The next time starts from the current path again.
    openByShortcut();
    expect(field()).toHaveValue("/home/alice");
  });

  it("closes when it loses the focus", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.blur(field());
    expect(queryField()).toBeNull();
  });

  it("stays open when the whole window loses the focus", async () => {
    await openLocal();
    openByShortcut();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(field());
    expect(field()).toBeInTheDocument();
  });
});

describe("going to a path", () => {
  it("goes to an absolute path, with Back to return", async () => {
    await openLocal();
    await goTo("/srv/app");
    await waitFor(() => expect(local().path).toBe("/srv/app"));
    expect(queryField()).toBeNull();
    expect(await screen.findByText("index.html")).toBeInTheDocument();
    expect(local().history).toEqual(["/home/alice"]);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(local().path).toBe("/home/alice"));
  });

  it("goes to a relative path", async () => {
    await openLocal();
    await goTo("docs/");
    await waitFor(() => expect(local().path).toBe("/home/alice/docs"));
  });

  it("goes up with .. and selects the folder it came from", async () => {
    await openLocal("/home/alice/docs");
    await goTo("..");
    await waitFor(() => expect(local().path).toBe("/home/alice"));
    expect(local().selection).toEqual(["/home/alice/docs"]);
  });

  it("goes up several levels and clamps at the root", async () => {
    await openLocal("/home/alice/docs");
    await goTo("../../../../..");
    await waitFor(() => expect(local().path).toBe("/"));
  });

  it("goes to ~ on the local side with the local home", async () => {
    await openLocal("/srv/app");
    await goTo("~");
    await waitFor(() => expect(local().path).toBe("/home/alice"));
    expect(homeDir).toHaveBeenCalledWith({ kind: "local" });
  });

  it("goes to ~/x on the remote side with the session's login folder", async () => {
    await openRemote();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "~" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(remote().path).toBe("/srv/home"));
    expect(homeDir).toHaveBeenCalledWith({ kind: "remote", sessionId: "s-1" });
    expect(local().path).toBeNull();
  });

  it("goes to a relative path on the remote side", async () => {
    await openRemote();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "../home" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(remote().path).toBe("/srv/home"));
    expect(stat).toHaveBeenCalledWith(
      { kind: "remote", sessionId: "s-1" },
      "/srv/home",
    );
  });

  it("trims whitespace and quotes", async () => {
    await openLocal();
    await goTo('  "/srv/app"  ');
    await waitFor(() => expect(local().path).toBe("/srv/app"));
  });

  it("opens the parent of a file and selects it", async () => {
    await openLocal("/srv/app");
    await goTo("/home/alice/notes.txt");
    await waitFor(() => expect(local().path).toBe("/home/alice"));
    expect(local().selection).toEqual(["/home/alice/notes.txt"]);
    expect(local().cursor).toBe("/home/alice/notes.txt");
    expect(queryField()).toBeNull();
  });

  it("selects a file next to the current folder's own entries", async () => {
    await openLocal();
    await goTo("zebra.txt");
    await waitFor(() =>
      expect(local().selection).toEqual(["/home/alice/zebra.txt"]),
    );
    expect(local().path).toBe("/home/alice");
  });

  it("follows a symlink to a folder", async () => {
    await openLocal("/srv/app");
    await goTo("/home/alice/link-to-docs");
    await waitFor(() => expect(local().path).toBe("/home/alice/link-to-docs"));
  });

  it("does nothing for empty text", async () => {
    await openLocal();
    await goTo("   ");
    await waitFor(() => expect(queryField()).toBeNull());
    expect(stat).not.toHaveBeenCalled();
    expect(local().path).toBe("/home/alice");
  });
});

describe("errors", () => {
  it("keeps the field open with the text on a missing folder", async () => {
    await openLocal();
    await goTo("/nope/missing");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No such folder",
    );
    expect(field()).toHaveValue("/nope/missing");
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(local().path).toBe("/home/alice");
    expect(useToastStore.getState().toasts).toEqual([]);
    // Typing clears the message.
    fireEvent.change(field(), { target: { value: "/srv" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when a folder is not permitted", async () => {
    await openLocal();
    // stat works, the listing is refused.
    await goTo("/locked");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Permission denied",
    );
    expect(field()).toHaveValue("/locked");
    expect(local().path).toBe("/home/alice");
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("says when stat is not permitted", async () => {
    vi.mocked(stat).mockRejectedValueOnce(ipcError("permissionDenied"));
    await openLocal();
    await goTo("/srv");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Permission denied",
    );
  });

  it("shows other errors with their own message", async () => {
    vi.mocked(stat).mockRejectedValueOnce(
      ipcError("remote", "Server timed out"),
    );
    await openLocal();
    await goTo("/srv");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server timed out",
    );
  });

  it("can try again after an error", async () => {
    await openLocal();
    await goTo("/nope");
    await screen.findByRole("alert");
    fireEvent.change(field(), { target: { value: "/srv" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(local().path).toBe("/srv"));
  });
});

describe("Tab completion", () => {
  it("completes a unique folder and adds a slash", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "/home/alice/doc" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    await waitFor(() => expect(field()).toHaveValue("/home/alice/docs/"));
    expect(screen.queryByRole("listbox")).toBeNull();
    // Files do not count: "no" would only match notes.txt.
    fireEvent.change(field(), { target: { value: "no" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    await waitFor(() => expect(listDir).toHaveBeenCalledTimes(2));
    expect(field()).toHaveValue("no");
  });

  it("completes relative to the current folder and after ..", async () => {
    await openLocal("/srv/app");
    openByShortcut();
    fireEvent.change(field(), { target: { value: "../ho" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    await waitFor(() => expect(field()).toHaveValue("../home/"));
    expect(listDir).toHaveBeenLastCalledWith({ kind: "local" }, "/srv");
  });

  it("completes the common prefix of several folders and lists them", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "/home/alice/d" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    const list = await screen.findByRole("listbox");
    // "docs" and "downloads" share "do".
    expect(field()).toHaveValue("/home/alice/do");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["docs", "downloads"]);
    expect(list).toBeInTheDocument();

    // Arrow keys move, Enter picks (and does not go there yet).
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field()).toHaveValue("/home/alice/downloads/");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(local().path).toBe("/home/alice");
    // Enter again goes.
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(local().path).toBe("/home/alice/downloads"));
  });

  it("lists every visible folder for an empty last segment", async () => {
    await openLocal();
    openByShortcut();
    // Hidden folders stay out unless a dot is typed.
    fireEvent.change(field(), { target: { value: "/home/alice/" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "docs",
        "downloads",
        "link-to-docs",
      ]),
    );
  });

  it("completes hidden folders only when a dot is typed", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "/home/alice/.co" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    await waitFor(() => expect(field()).toHaveValue("/home/alice/.config/"));
  });

  it("picks a suggestion with the mouse without closing the field", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "/home/alice/d" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    fireEvent.click(await screen.findByRole("option", { name: "docs" }));
    expect(field()).toHaveValue("/home/alice/docs/");
  });

  it("lists each folder once while the field is open", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "/home/alice/d" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    await screen.findByRole("listbox");
    fireEvent.change(field(), { target: { value: "/home/alice/l" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    await waitFor(() =>
      expect(field()).toHaveValue("/home/alice/link-to-docs/"),
    );
    // The pane's own listing + one for the completion.
    expect(
      vi.mocked(listDir).mock.calls.filter(([, p]) => p === "/home/alice"),
    ).toHaveLength(2);
  });

  it("runs one listing at a time", async () => {
    await openLocal();
    openByShortcut();
    let release: (entries: Entry[]) => void = () => undefined;
    vi.mocked(listDir).mockImplementationOnce(
      () => new Promise<Entry[]>((resolve) => (release = resolve)),
    );
    fireEvent.change(field(), { target: { value: "/srv/a" } });
    vi.mocked(listDir).mockClear();
    fireEvent.keyDown(field(), { key: "Tab" });
    fireEvent.keyDown(field(), { key: "Tab" });
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(listDir).toHaveBeenCalledTimes(1);
    await act(async () => release(TREE["/srv"]));
    await waitFor(() => expect(field()).toHaveValue("/srv/app/"));
  });

  it("drops a result for text that was typed over", async () => {
    await openLocal();
    openByShortcut();
    let release: (entries: Entry[]) => void = () => undefined;
    vi.mocked(listDir).mockImplementationOnce(
      () => new Promise<Entry[]>((resolve) => (release = resolve)),
    );
    fireEvent.change(field(), { target: { value: "/srv/a" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    fireEvent.change(field(), { target: { value: "/srv/ap" } });
    await act(async () => release(TREE["/srv"]));
    expect(field()).toHaveValue("/srv/ap");
  });

  it("completes ~/ with the home folder", async () => {
    await openLocal("/srv/app");
    openByShortcut();
    fireEvent.change(field(), { target: { value: "~/dow" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    await waitFor(() => expect(field()).toHaveValue("~/downloads/"));
  });

  it("shows a listing error inline", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "/nowhere/x" } });
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No such folder",
    );
  });
});

describe("keys while the field is focused", () => {
  it("does not type-select rows or trigger pane shortcuts", async () => {
    await openLocal();
    openByShortcut();
    const input = field();
    for (const key of ["n", "z", " ", "Delete", "F2"]) {
      fireEvent.keyDown(input, { key });
    }
    fireEvent.keyDown(input, { key: "N", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(input, { key: "Backspace", ctrlKey: true });
    fireEvent.keyDown(input, { key: "i", ctrlKey: true });
    expect(local().selection).toEqual([]);
    expect(local().cursor).toBeNull();
    expect(local().editing).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText(/^Rename/)).toBeNull();
    expect(input).toBeInTheDocument();
  });

  it("does not reopen or reset the field when Ctrl+L is typed in it", async () => {
    await openLocal();
    openByShortcut();
    fireEvent.change(field(), { target: { value: "/srv" } });
    fireEvent.keyDown(field(), { key: "l", ctrlKey: true });
    expect(field()).toHaveValue("/srv");
  });
});

describe("remote pane without a live session", () => {
  it("does not open the field while reconnecting", async () => {
    await openRemote("reconnecting");
    fireEvent.keyDown(grid(), { key: "p", ctrlKey: true });
    fireEvent.keyDown(grid(), { key: "l", ctrlKey: true });
    fireEvent.click(screen.getByRole("navigation", { name: "Path" }));
    fireEvent.doubleClick(screen.getByText("app"));
    expect(queryField()).toBeNull();
  });

  it("closes the field when the session drops", async () => {
    await openRemote();
    openByShortcut();
    expect(field()).toBeInTheDocument();
    act(() =>
      useSessionStore.getState().apply({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: {
          status: "reconnecting",
          attempt: 1,
          maxAttempts: 5,
          nextRetryInSecs: 3,
        },
      }),
    );
    expect(queryField()).toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Path" }),
    ).toBeInTheDocument();
  });

  it("has no field in the welcome state", () => {
    render(<Pane id="remote" title="Remote" Icon={ServerIcon} />);
    expect(queryField()).toBeNull();
  });
});
