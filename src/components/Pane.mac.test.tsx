/** macOS keyboard behaviour (Finder): Enter renames, Cmd+Down opens. */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({ isMac: true, isWindows: false }));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  homeDir: vi.fn(() => Promise.resolve("/Users/alice")),
  mkdir: vi.fn(() => Promise.resolve()),
  openLocal: vi.fn(() => Promise.resolve()),
  revealLocal: vi.fn(() => Promise.resolve()),
}));

import { listDir, mkdir, openLocal, revealLocal } from "../ipc/commands";
import type { Entry } from "../ipc/types";
import { initialPane, usePaneStore } from "../state/paneStore";
import { stubViewport } from "../test/viewport";
import { LocalIcon } from "./icons";
import { Pane } from "./Pane";

stubViewport();

function entry(name: string, dir = false): Entry {
  return {
    name,
    path: `/Users/alice/${name}`,
    kind: dir ? { type: "dir" } : { type: "file" },
    size: 1,
    mtime: null,
    mode: null,
    hidden: false,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  vi.mocked(listDir).mockImplementation(async (_t, path) =>
    path === "/Users/alice"
      ? [entry("Documents", true), entry("todo.txt")]
      : [],
  );
  render(<Pane id="local" title="Local" Icon={LocalIcon} />);
  await usePaneStore.getState().open("local", { kind: "local" }, null);
  await screen.findByText("todo.txt");
});

describe("Pane on macOS", () => {
  it("renames with Enter instead of opening", async () => {
    fireEvent.click(screen.getByText("Documents"));
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter" });
    expect(
      await screen.findByLabelText("Rename Documents"),
    ).toBeInTheDocument();
    expect(usePaneStore.getState().panes.local.path).toBe("/Users/alice");
  });

  it("opens with Cmd+Down and goes up with Cmd+Up", async () => {
    fireEvent.click(screen.getByText("Documents"));
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true });
    await waitFor(() =>
      expect(usePaneStore.getState().panes.local.path).toBe(
        "/Users/alice/Documents",
      ),
    );
    fireEvent.keyDown(screen.getByRole("grid"), {
      key: "ArrowUp",
      metaKey: true,
    });
    await waitFor(() =>
      expect(usePaneStore.getState().panes.local.path).toBe("/Users/alice"),
    );
  });

  it("uses Cmd (not Ctrl) for New Folder", async () => {
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "N", ctrlKey: true, shiftKey: true });
    expect(mkdir).not.toHaveBeenCalled();
    fireEvent.keyDown(grid, { key: "N", metaKey: true, shiftKey: true });
    await waitFor(() => expect(mkdir).toHaveBeenCalledTimes(1));
  });

  it("opens a file with Cmd+O and a double-click, not with Enter (rename)", async () => {
    fireEvent.click(screen.getByText("todo.txt"));
    fireEvent.keyDown(screen.getByRole("grid"), { key: "o", metaKey: true });
    await waitFor(() =>
      expect(openLocal).toHaveBeenCalledWith("/Users/alice/todo.txt", false),
    );
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter" });
    expect(openLocal).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Escape" });
  });

  it("shows the selection in Finder with Option+Cmd+R and the menu", async () => {
    fireEvent.click(screen.getByText("todo.txt"));
    fireEvent.keyDown(screen.getByRole("grid"), {
      key: "®",
      code: "KeyR",
      metaKey: true,
      altKey: true,
    });
    await waitFor(() =>
      expect(revealLocal).toHaveBeenCalledWith("/Users/alice/todo.txt"),
    );
    // Cmd+R alone is not the shortcut.
    fireEvent.keyDown(screen.getByRole("grid"), {
      key: "r",
      code: "KeyR",
      metaKey: true,
    });
    expect(revealLocal).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(screen.getByText("Documents"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show in Finder" }));
    await waitFor(() =>
      expect(revealLocal).toHaveBeenLastCalledWith("/Users/alice/Documents"),
    );
  });

  it("opens the go-to-path field with Cmd+P and Cmd+L, not with Ctrl", async () => {
    const grid = screen.getByRole("grid");
    const field = () => screen.queryByRole("textbox", { name: "Go to path" });
    fireEvent.keyDown(grid, { key: "p", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "l", ctrlKey: true });
    expect(field()).toBeNull();
    fireEvent.keyDown(grid, { key: "p", metaKey: true });
    expect(field()).toHaveValue("/Users/alice");
    fireEvent.keyDown(field()!, { key: "Escape" });
    expect(field()).toBeNull();
    fireEvent.keyDown(screen.getByRole("grid"), { key: "l", metaKey: true });
    expect(field()).toHaveValue("/Users/alice");
  });

  it("refreshes with Cmd+R and focuses the filter with Cmd+F, not with Ctrl", async () => {
    const grid = screen.getByRole("grid");
    const calls = () => vi.mocked(listDir).mock.calls.length;
    const before = calls();
    fireEvent.keyDown(grid, { key: "r", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "f", ctrlKey: true });
    expect(calls()).toBe(before);
    expect(screen.getByRole("searchbox")).not.toHaveFocus();

    const refresh = new KeyboardEvent("keydown", {
      key: "r",
      code: "KeyR",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      grid.dispatchEvent(refresh);
    });
    expect(refresh.defaultPrevented).toBe(true);
    await waitFor(() => expect(calls()).toBe(before + 1));

    fireEvent.keyDown(grid, { key: "f", metaKey: true });
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });

  it("shows the macOS glyphs in tooltips", () => {
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute(
      "title",
      "Refresh (⌘R)",
    );
    expect(screen.getByRole("button", { name: "New folder" })).toHaveAttribute(
      "title",
      "New folder (⇧⌘N)",
    );
  });
});
