/** Pane shortcuts from the keymap (Ctrl; macOS is in Pane.mac.test.tsx). */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
  listTransfers: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("../lib/connect", () => ({
  connectInTab: vi.fn(),
  retrySession: vi.fn(),
}));
vi.mock("../lib/tabs", () => ({ requestDisconnectSession: vi.fn() }));

import { listDir } from "../ipc/commands";
import type { Entry } from "../ipc/types";
import type { ActionId } from "../lib/keymap";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useSettingsStore } from "../state/settingsStore";
import { resetTabs } from "../state/tabsStore";
import { stubViewport } from "../test/viewport";
import { LocalIcon } from "./icons";
import { Pane } from "./Pane";

stubViewport();

function entry(name: string): Entry {
  return {
    name,
    path: `/home/alice/${name}`,
    kind: { type: "file" },
    size: 10,
    mtime: null,
    mode: null,
    hidden: false,
  };
}
const NAMES = ["papers.txt", "pictures.png", "notes.txt"];

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsStore.getState().resetShortcuts();
  resetTabs();
  useLayoutStore.getState().setPreviewOpen(false);
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  vi.mocked(listDir).mockImplementation(async () => NAMES.map(entry));
  render(<Pane id="local" title="Local" Icon={LocalIcon} />);
  await usePaneStore.getState().open("local", { kind: "local" }, "/home/alice");
  await screen.findByText("notes.txt");
});

const grid = () => screen.getByRole("grid");
const filter = () => screen.getByRole("searchbox") as HTMLInputElement;
const goToField = () => screen.queryByRole("textbox", { name: "Go to path" });
const selected = () => usePaneStore.getState().panes.local.selection;

function bind(action: ActionId, list: string[]) {
  act(() => useSettingsStore.getState().setShortcut(action, list));
}

/** Fires a keydown and says whether the app prevented its default. */
function press(target: Element | Document, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("default shortcuts", () => {
  it("Ctrl+P opens go to path and does not print", () => {
    const e = press(grid(), { key: "p", code: "KeyP", ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(goToField()).toBeInTheDocument();
  });

  it("Ctrl+L opens it too", () => {
    press(grid(), { key: "l", code: "KeyL", ctrlKey: true });
    expect(goToField()).toBeInTheDocument();
  });

  it("Ctrl+R refreshes the folder and does not reload the webview", async () => {
    const before = vi.mocked(listDir).mock.calls.length;
    const e = press(grid(), { key: "r", code: "KeyR", ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(vi.mocked(listDir).mock.calls.length).toBe(before + 1),
    );
  });

  it("Ctrl+Alt+R is still Show in Finder, not Refresh", () => {
    const before = vi.mocked(listDir).mock.calls.length;
    press(grid(), { key: "®", code: "KeyR", ctrlKey: true, altKey: true });
    expect(vi.mocked(listDir).mock.calls.length).toBe(before);
  });

  it("Ctrl+F focuses the filter and selects its text", () => {
    fireEvent.change(filter(), { target: { value: "pap" } });
    grid().focus();
    const e = press(grid(), { key: "f", code: "KeyF", ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(filter()).toHaveFocus();
    expect(filter().selectionStart).toBe(0);
    expect(filter().selectionEnd).toBe(3);
  });

  it("Escape in the filter clears it and returns the focus to the table", () => {
    press(grid(), { key: "f", code: "KeyF", ctrlKey: true });
    fireEvent.change(filter(), { target: { value: "pap" } });
    expect(screen.queryByText("notes.txt")).toBeNull();
    fireEvent.keyDown(filter(), { key: "Escape" });
    expect(filter()).toHaveValue("");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(grid()).toHaveFocus();
  });

  it("Escape in an empty filter still gives the focus back", () => {
    filter().focus();
    fireEvent.keyDown(filter(), { key: "Escape" });
    expect(grid()).toHaveFocus();
  });

  it("Ctrl+F in the filter selects the text again instead of acting on the pane", () => {
    fireEvent.change(filter(), { target: { value: "pic" } });
    filter().focus();
    filter().setSelectionRange(3, 3);
    const e = press(filter(), { key: "f", code: "KeyF", ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(filter().selectionStart).toBe(0);
  });

  it("toolbar tooltips show the current binding", () => {
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute(
      "title",
      "Refresh (Ctrl+R)",
    );
    expect(screen.getByRole("button", { name: "New folder" })).toHaveAttribute(
      "title",
      "New folder (Ctrl+Shift+N)",
    );
    expect(filter()).toHaveAttribute("title", "Filter this folder (Ctrl+F)");
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute(
      "title",
      "Preview (Ctrl+Alt+P or Space)",
    );
  });

  it("shows the bindings in the context menu", () => {
    fireEvent.contextMenu(screen.getByText("notes.txt"));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Ctrl+R");
    expect(menu).toHaveTextContent("Ctrl+Shift+N");
    // The hint is not part of the item's accessible name.
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toBeVisible();
  });
});

describe("a rebound shortcut", () => {
  it("works in the pane, and the old combination stops", () => {
    bind("goTo", ["Mod+KeyK"]);
    press(grid(), { key: "p", code: "KeyP", ctrlKey: true });
    press(grid(), { key: "l", code: "KeyL", ctrlKey: true });
    expect(goToField()).toBeNull();
    press(grid(), { key: "k", code: "KeyK", ctrlKey: true });
    expect(goToField()).toBeInTheDocument();
  });

  it("moves Refresh to Ctrl+Alt+K and shows it in the tooltip", async () => {
    bind("refresh", ["Mod+Alt+KeyK"]);
    const before = vi.mocked(listDir).mock.calls.length;
    press(grid(), { key: "r", code: "KeyR", ctrlKey: true });
    expect(vi.mocked(listDir).mock.calls.length).toBe(before);
    press(grid(), { key: "˚", code: "KeyK", ctrlKey: true, altKey: true });
    await waitFor(() =>
      expect(vi.mocked(listDir).mock.calls.length).toBe(before + 1),
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute(
      "title",
      "Refresh (Ctrl+Alt+K)",
    );
  });

  it("a bound letter combination is never typed into type-to-select", () => {
    bind("goTo", ["Mod+KeyK"]);
    press(grid(), { key: "k", code: "KeyK", ctrlKey: true });
    expect(selected()).toEqual([]);
  });
});

describe("type-to-select and fields", () => {
  it("still selects by typing", () => {
    press(grid(), { key: "p", code: "KeyP" });
    expect(selected()).toEqual(["/home/alice/papers.txt"]);
    press(grid(), { key: "i", code: "KeyI" });
    expect(selected()).toEqual(["/home/alice/pictures.png"]);
  });

  it("Ctrl+P does not type-select a row starting with p", () => {
    press(grid(), { key: "p", code: "KeyP", ctrlKey: true });
    expect(selected()).toEqual([]);
  });

  it("ignores shortcuts typed in the filter box", () => {
    filter().focus();
    const before = vi.mocked(listDir).mock.calls.length;
    press(filter(), { key: "p", code: "KeyP", ctrlKey: true });
    press(filter(), { key: "l", code: "KeyL", ctrlKey: true });
    press(filter(), { key: "r", code: "KeyR", ctrlKey: true });
    expect(goToField()).toBeNull();
    expect(vi.mocked(listDir).mock.calls.length).toBe(before);
  });

  it("takes shortcuts while nothing is focused", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const before = vi.mocked(listDir).mock.calls.length;
    press(document.body, { key: "r", code: "KeyR", ctrlKey: true });
    await waitFor(() =>
      expect(vi.mocked(listDir).mock.calls.length).toBe(before + 1),
    );
    press(document.body, { key: "p", code: "KeyP", ctrlKey: true });
    expect(goToField()).toBeInTheDocument();
  });

  it("does not take them while a dialog is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    press(document.body, { key: "p", code: "KeyP", ctrlKey: true });
    expect(goToField()).toBeNull();
    dialog.remove();
  });
});
