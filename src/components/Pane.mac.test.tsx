/** macOS keyboard behaviour (Finder): Enter renames, Cmd+Down opens. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
