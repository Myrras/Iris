import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  homeDir: vi.fn(),
}));
vi.mock("./toastStore", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import { homeDir, listDir } from "../ipc/commands";
import type { Entry } from "../ipc/types";
import { initialPane, usePaneStore } from "./paneStore";
import { useSettingsStore } from "./settingsStore";

function entry(parent: string, name: string, hidden = false): Entry {
  return {
    name,
    path: `${parent === "/" ? "" : parent}/${name}`,
    kind: { type: "dir" },
    size: 0,
    mtime: null,
    mode: null,
    hidden,
  };
}

/** Every folder holds b, c (a sibling) and .secret. */
function listEverywhere() {
  vi.mocked(listDir).mockImplementation(async (_t, path) => [
    entry(path, "b"),
    entry(path, "c"),
    entry(path, ".c2", true),
  ]);
}

const pane = () => usePaneStore.getState().panes.local;
const local = { kind: "local" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  useSettingsStore.getState().set("browser", { showHidden: false });
  vi.mocked(homeDir).mockResolvedValue("/a/b/c");
  listEverywhere();
});

describe("selecting the folder you came from", () => {
  it("Up selects the origin", async () => {
    await usePaneStore.getState().open("local", local, "/a/b/c");
    await usePaneStore.getState().up("local");
    expect(pane().path).toBe("/a/b");
    expect(pane()).toMatchObject({
      selection: ["/a/b/c"],
      anchor: "/a/b/c",
      cursor: "/a/b/c",
    });
  });

  it("a breadcrumb jump selects the child on the way", async () => {
    await usePaneStore.getState().open("local", local, "/a/b/c");
    await usePaneStore.getState().navigate("local", "/a");
    expect(pane().selection).toEqual(["/a/b"]);
  });

  it("going deeper or sideways selects nothing", async () => {
    await usePaneStore.getState().open("local", local, "/a");
    await usePaneStore.getState().navigate("local", "/a/b");
    expect(pane().selection).toEqual([]);
    await usePaneStore.getState().navigate("local", "/x");
    expect(pane().selection).toEqual([]);
  });

  it("Back to a parent selects the origin", async () => {
    await usePaneStore.getState().open("local", local, "/a/b");
    await usePaneStore.getState().navigate("local", "/a/b/c");
    await usePaneStore.getState().back("local");
    expect(pane().path).toBe("/a/b");
    expect(pane().selection).toEqual(["/a/b/c"]);
  });

  it("selects nothing when the origin is hidden and hidden files are off", async () => {
    vi.mocked(listDir).mockImplementation(async (_t, path) => [
      entry(path, "c", true),
    ]);
    await usePaneStore.getState().open("local", local, "/a/b/c");
    await usePaneStore.getState().up("local");
    expect(pane().selection).toEqual([]);
    expect(pane().cursor).toBeNull();
    expect(pane().showHidden).toBeNull();

    usePaneStore.getState().setShowHidden("local", true);
    await usePaneStore.getState().navigate("local", "/a/b/c");
    await usePaneStore.getState().up("local");
    expect(pane().selection).toEqual(["/a/b/c"]);
  });

  it("a stale listing never applies its selection", async () => {
    await usePaneStore.getState().open("local", local, "/a/b/c");
    let release: (e: Entry[]) => void = () => undefined;
    vi.mocked(listDir).mockImplementationOnce(
      () => new Promise<Entry[]>((r) => (release = r)),
    );
    const up = usePaneStore.getState().up("local"); // slow listing of /a/b
    listEverywhere();
    await usePaneStore.getState().navigate("local", "/x");
    release([entry("/a/b", "c")]);
    await up;
    expect(pane().path).toBe("/x");
    expect(pane().selection).toEqual([]);
  });
});
