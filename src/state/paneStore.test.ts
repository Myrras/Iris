import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  homeDir: vi.fn(),
}));
vi.mock("./toastStore", () => ({ toastError: vi.fn() }));

import { homeDir, listDir } from "../ipc/commands";
import type { Entry, FsTarget } from "../ipc/types";
import { initialPane, usePaneStore } from "./paneStore";
import { toastError } from "./toastStore";

const local: FsTarget = { kind: "local" };
const remote: FsTarget = { kind: "remote", sessionId: "s-1" };

function file(path: string): Entry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    kind: { type: "file" },
    size: 1,
    mtime: null,
    mode: null,
    hidden: false,
  };
}

/** listDir answers with one file named after the folder. */
function listingPerFolder() {
  vi.mocked(listDir).mockImplementation(async (_t, path) => [
    file(`${path === "/" ? "" : path}/inside`),
  ]);
}

const pane = (id: "local" | "remote" = "local") =>
  usePaneStore.getState().panes[id];

beforeEach(() => {
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  listingPerFolder();
  vi.mocked(homeDir).mockResolvedValue("/home/alice");
});

describe("paneStore", () => {
  it("opens a target in its home folder", async () => {
    await usePaneStore.getState().open("local", local, null);
    expect(homeDir).toHaveBeenCalledWith(local);
    expect(pane()).toMatchObject({
      target: local,
      path: "/home/alice",
      loading: false,
      history: [],
    });
    expect(pane().entries.map((e) => e.path)).toEqual(["/home/alice/inside"]);
  });

  it("opens a remote session in its start folder", async () => {
    await usePaneStore.getState().open("remote", remote, "/srv");
    expect(homeDir).not.toHaveBeenCalled();
    expect(listDir).toHaveBeenCalledWith(remote, "/srv");
    expect(pane("remote").path).toBe("/srv");
  });

  it("falls back to home when the start folder cannot be opened", async () => {
    vi.mocked(listDir).mockImplementation(async (_t, path) => {
      if (path === "/gone") throw { kind: "notFound", message: "not found" };
      return [file(`${path}/inside`)];
    });
    await usePaneStore.getState().open("remote", remote, "/gone");
    expect(pane("remote").path).toBe("/home/alice");
    expect(toastError).toHaveBeenCalledWith(
      "Could not open /gone",
      "not found",
    );
  });

  it("navigates, remembers history and goes back", async () => {
    const store = usePaneStore.getState();
    await store.open("local", local, null);
    await store.navigate("local", "/home/alice/docs");
    await store.navigate("local", "/home/alice/docs/2024");
    expect(pane().history).toEqual(["/home/alice", "/home/alice/docs"]);

    await store.back("local");
    expect(pane().path).toBe("/home/alice/docs");
    expect(pane().history).toEqual(["/home/alice"]);
  });

  it("goes up to the parent folder", async () => {
    const store = usePaneStore.getState();
    await store.open("local", local, null);
    await store.up("local");
    expect(pane().path).toBe("/home");
    await store.up("local");
    await store.up("local");
    expect(pane().path).toBe("/");
  });

  it("clears the filter and selection when navigating", async () => {
    const store = usePaneStore.getState();
    await store.open("local", local, null);
    store.setFilter("local", "abc");
    store.setSelection("local", {
      selection: ["/home/alice/inside"],
      anchor: "/home/alice/inside",
      cursor: "/home/alice/inside",
    });
    await store.navigate("local", "/tmp");
    expect(pane()).toMatchObject({ filter: "", selection: [], cursor: null });
  });

  it("keeps the folder and toasts when a navigation fails", async () => {
    const store = usePaneStore.getState();
    await store.open("local", local, null);
    vi.mocked(listDir).mockRejectedValueOnce({
      kind: "permissionDenied",
      message: "permission denied",
    });
    await store.navigate("local", "/root");
    expect(pane().path).toBe("/home/alice");
    expect(pane().loading).toBe(false);
    expect(toastError).toHaveBeenCalledWith(
      "Could not open /root",
      "permission denied",
    );
  });

  it("does not toast when the session is gone (the pane shows that)", async () => {
    const store = usePaneStore.getState();
    await store.open("remote", remote, "/srv");
    vi.mocked(listDir).mockRejectedValueOnce({
      kind: "notConnected",
      message: "not connected",
    });
    await store.refresh("remote");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("ignores a stale listing that resolves after a newer one", async () => {
    const store = usePaneStore.getState();
    await store.open("local", local, null);
    let release: (v: Entry[]) => void = () => undefined;
    vi.mocked(listDir).mockImplementationOnce(
      () => new Promise<Entry[]>((r) => (release = r)),
    );
    const slow = store.navigate("local", "/slow");
    await store.navigate("local", "/fast");
    release([file("/slow/inside")]);
    await slow;
    expect(pane().path).toBe("/fast");
    expect(pane().entries.map((e) => e.path)).toEqual(["/fast/inside"]);
  });

  it("refreshes in place, keeping the selection that still exists", async () => {
    const store = usePaneStore.getState();
    await store.open("local", local, null);
    store.setSelection("local", {
      selection: ["/home/alice/inside", "/home/alice/deleted"],
      anchor: "/home/alice/deleted",
      cursor: "/home/alice/deleted",
    });
    await store.refresh("local");
    expect(pane().path).toBe("/home/alice");
    expect(pane().history).toEqual([]);
    expect(pane().selection).toEqual(["/home/alice/inside"]);
    expect(pane().cursor).toBeNull();
  });

  it("toggles the sort direction on the same column", () => {
    const store = usePaneStore.getState();
    expect(pane().sort).toEqual({ key: "name", dir: "asc" });
    store.setSort("local", "name");
    expect(pane().sort).toEqual({ key: "name", dir: "desc" });
    store.setSort("local", "size");
    expect(pane().sort).toEqual({ key: "size", dir: "asc" });
  });

  it("follows the settings for hidden files until toggled", () => {
    expect(pane().showHidden).toBeNull();
    usePaneStore.getState().setShowHidden("local", true);
    expect(pane().showHidden).toBe(true);
  });

  it("closes a pane back to its empty state", async () => {
    await usePaneStore.getState().open("remote", remote, "/srv");
    usePaneStore.getState().close("remote");
    expect(pane("remote")).toMatchObject({
      target: null,
      path: null,
      entries: [],
    });
  });
});
