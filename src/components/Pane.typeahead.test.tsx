import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { TYPE_AHEAD_RESET_MS } from "../lib/typeAhead";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useSettingsStore } from "../state/settingsStore";
import { resetTabs } from "../state/tabsStore";
import { stubViewport } from "../test/viewport";
import { LocalIcon } from "./icons";
import { Pane } from "./Pane";

stubViewport();

function entry(name: string, dir = false, parent = "/home/alice"): Entry {
  return {
    name,
    path: `${parent}/${name}`,
    kind: dir ? { type: "dir" } : { type: "file" },
    size: 10,
    mtime: null,
    mode: null,
    hidden: name.startsWith("."),
  };
}

const NAMES = ["Applications", "Desktop", "Documents", "Library", "Movies"];

beforeEach(() => {
  vi.clearAllMocks();
  resetTabs();
  useLayoutStore.getState().setPreviewOpen(false);
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  useSettingsStore.getState().set("browser", { showHidden: false });
  vi.mocked(listDir).mockImplementation(async (_t, path) =>
    path === "/home/alice"
      ? NAMES.map((n) => entry(n, true))
      : [entry("inside.txt", false, path)],
  );
});
afterEach(() => vi.useRealTimers());

async function openLocal() {
  render(<Pane id="local" title="Local" Icon={LocalIcon} />);
  await usePaneStore.getState().open("local", { kind: "local" }, null);
  await screen.findByText("Library");
}
const grid = () => screen.getByRole("grid");
const type = (...keys: string[]) =>
  keys.forEach((key) => fireEvent.keyDown(grid(), { key }));
const selected = () => usePaneStore.getState().panes.local.selection;
const sel = (name: string) => [`/home/alice/${name}`];

describe("type-to-select", () => {
  it("selects by prefix and refines it", async () => {
    await openLocal();
    type("L");
    expect(selected()).toEqual(sel("Library"));
    type("i");
    expect(selected()).toEqual(sel("Library"));
    expect(usePaneStore.getState().panes.local.cursor).toBe(
      "/home/alice/Library",
    );
  });

  it("is case-insensitive and refines to the right entry", async () => {
    await openLocal();
    type("d");
    expect(selected()).toEqual(sel("Desktop"));
    type("O");
    expect(selected()).toEqual(sel("Documents"));
  });

  it("falls back to the closest match and keeps the selection otherwise", async () => {
    await openLocal();
    type("d", "z");
    expect(selected()).toEqual(sel("Library"));
  });

  it("selects the last entry when the buffer sorts after everything", async () => {
    await openLocal();
    type("z");
    expect(selected()).toEqual(sel("Movies"));
  });

  it("starts over after one second of quiet", async () => {
    await openLocal();
    vi.useFakeTimers();
    type("l");
    expect(selected()).toEqual(sel("Library"));
    vi.advanceTimersByTime(TYPE_AHEAD_RESET_MS + 1);
    type("d");
    expect(selected()).toEqual(sel("Desktop"));
  });

  it("resets when the folder changes", async () => {
    await openLocal();
    type("d"); // buffer "d"
    await usePaneStore.getState().navigate("local", "/home/alice/Desktop");
    await screen.findByText("inside.txt");
    type("i");
    expect(selected()).toEqual(["/home/alice/Desktop/inside.txt"]);
  });

  it("ignores Cmd/Ctrl/Alt combinations", async () => {
    await openLocal();
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }])
      fireEvent.keyDown(grid(), { key: "l", ...mods });
    expect(selected()).toEqual([]);
  });

  it("ignores typing in the filter box and the rename field", async () => {
    await openLocal();
    fireEvent.keyDown(screen.getByLabelText("Filter Local files"), {
      key: "l",
    });
    expect(selected()).toEqual([]);
    act(() =>
      usePaneStore.getState().startRename("local", "/home/alice/Movies"),
    );
    const before = selected();
    const input = await screen.findByLabelText("Rename Movies");
    fireEvent.keyDown(input, { key: "l" });
    expect(selected()).toEqual(before);
  });

  it("appends Space while typing, toggles the preview when idle", async () => {
    vi.mocked(listDir).mockResolvedValue([
      entry("My Docs"),
      entry("Mystery"),
      entry("Zed"),
    ]);
    render(<Pane id="local" title="Local" Icon={LocalIcon} />);
    await usePaneStore.getState().open("local", { kind: "local" }, null);
    await screen.findByText("My Docs");
    type("m", "y", " ", "d");
    expect(selected()).toEqual(sel("My Docs"));
    expect(useLayoutStore.getState().previewOpen).toBe(false);

    vi.useFakeTimers();
    vi.advanceTimersByTime(TYPE_AHEAD_RESET_MS + 1);
    type(" ");
    expect(useLayoutStore.getState().previewOpen).toBe(true);
  });

  it("follows the current sort and filter", async () => {
    await openLocal();
    act(() => usePaneStore.getState().setSort("local", "name")); // descending
    type("d");
    expect(selected()).toEqual(sel("Documents"));

    act(() => usePaneStore.getState().setFilter("local", "esk"));
    vi.useFakeTimers();
    vi.advanceTimersByTime(TYPE_AHEAD_RESET_MS + 1);
    type("d");
    expect(selected()).toEqual(sel("Desktop"));
    // "Do" is filtered out: closest match among the visible rows.
    type("o");
    expect(selected()).toEqual(sel("Desktop"));
  });
});
