import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  homeDir: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  deletePaths: vi.fn(),
  chmod: vi.fn(),
}));
vi.mock("./toastStore", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import {
  chmod,
  deletePaths,
  homeDir,
  listDir,
  mkdir,
  rename,
} from "../ipc/commands";
import type { Entry, FsTarget } from "../ipc/types";
import {
  actionTargets,
  focusedEntry,
  initialPane,
  usePaneStore,
} from "./paneStore";
import { toastError, toastSuccess } from "./toastStore";

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
  vi.clearAllMocks();
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

describe("paneStore file operations", () => {
  /** A fake folder on "disk" the mocked IPC reads and changes. */
  let disk: Entry[];

  function dir(path: string): Entry {
    return { ...file(path), kind: { type: "dir" } };
  }

  beforeEach(async () => {
    disk = [file("/home/alice/notes.txt"), dir("/home/alice/untitled folder")];
    vi.mocked(listDir).mockImplementation(async () => [...disk]);
    vi.mocked(mkdir).mockImplementation(async (_t, path) => {
      if (disk.some((e) => e.path === path))
        throw { kind: "alreadyExists", message: `already exists: ${path}` };
      disk.push(dir(path));
    });
    vi.mocked(rename).mockImplementation(async (_t, from, to) => {
      disk = disk.map((e) =>
        e.path === from
          ? { ...e, path: to, name: to.split("/").pop() ?? to }
          : e,
      );
    });
    await usePaneStore.getState().open("local", local, null);
  });

  it("creates a numbered untitled folder, selects it and starts renaming", async () => {
    await usePaneStore.getState().newFolder("local");
    const created = "/home/alice/untitled folder 2";
    expect(mkdir).toHaveBeenCalledWith(local, created);
    expect(pane()).toMatchObject({
      selection: [created],
      cursor: created,
      editing: created,
    });
    expect(pane().entries.map((e) => e.path)).toContain(created);
  });

  it("takes the next number when the listing was stale", async () => {
    disk.push(dir("/home/alice/untitled folder 2")); // created elsewhere
    await usePaneStore.getState().newFolder("local");
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(pane().editing).toBe("/home/alice/untitled folder 3");
  });

  it("renames in place and keeps the renamed entry selected", async () => {
    const store = usePaneStore.getState();
    store.startRename("local", "/home/alice/notes.txt");
    expect(pane().editing).toBe("/home/alice/notes.txt");
    await store.commitRename("local", "/home/alice/notes.txt", "ideas.txt");
    expect(rename).toHaveBeenCalledWith(
      local,
      "/home/alice/notes.txt",
      "/home/alice/ideas.txt",
    );
    expect(pane()).toMatchObject({
      editing: null,
      selection: ["/home/alice/ideas.txt"],
      cursor: "/home/alice/ideas.txt",
    });
  });

  it("does nothing for an unchanged name and refuses an invalid one", async () => {
    const store = usePaneStore.getState();
    await store.commitRename("local", "/home/alice/notes.txt", "notes.txt");
    await store.commitRename("local", "/home/alice/notes.txt", "a/b");
    expect(rename).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("toasts a rename onto an existing name", async () => {
    vi.mocked(rename).mockRejectedValueOnce({
      kind: "alreadyExists",
      message: "already exists: /home/alice/untitled folder",
    });
    await usePaneStore
      .getState()
      .commitRename("local", "/home/alice/notes.txt", "untitled folder");
    expect(toastError).toHaveBeenCalledWith(
      "Could not rename notes.txt",
      "already exists: /home/alice/untitled folder",
    );
  });

  it("deletes, refreshes and reports success and failures", async () => {
    vi.mocked(deletePaths).mockImplementation(async () => {
      disk = disk.filter((e) => e.path !== "/home/alice/notes.txt");
      return {
        succeeded: ["/home/alice/notes.txt"],
        failed: [
          {
            path: "/home/alice/untitled folder",
            kind: "permissionDenied",
            message: "permission denied: /home/alice/untitled folder",
          },
        ],
      };
    });
    await usePaneStore
      .getState()
      .remove("local", [
        "/home/alice/notes.txt",
        "/home/alice/untitled folder",
      ]);
    expect(pane().entries.map((e) => e.name)).toEqual(["untitled folder"]);
    expect(toastSuccess).toHaveBeenCalledWith("Moved 1 item to the Trash");
    expect(toastError).toHaveBeenCalledWith(
      "Could not delete untitled folder",
      "permission denied: /home/alice/untitled folder",
    );
  });

  it("says Deleted for remote deletes", async () => {
    vi.mocked(deletePaths).mockResolvedValue({
      succeeded: ["/srv/a", "/srv/b"],
      failed: [],
    });
    await usePaneStore.getState().open("remote", remote, "/srv");
    await usePaneStore.getState().remove("remote", ["/srv/a", "/srv/b"]);
    expect(deletePaths).toHaveBeenCalledWith(remote, ["/srv/a", "/srv/b"]);
    expect(toastSuccess).toHaveBeenCalledWith("Deleted 2 items");
  });

  it("changes permissions and refreshes", async () => {
    vi.mocked(chmod).mockResolvedValue({
      succeeded: ["/home/alice/untitled folder"],
      failed: [],
    });
    const calls = vi.mocked(listDir).mock.calls.length;
    await usePaneStore
      .getState()
      .chmod("local", ["/home/alice/untitled folder"], 0o750, true);
    expect(chmod).toHaveBeenCalledWith(
      local,
      ["/home/alice/untitled folder"],
      0o750,
      true,
    );
    expect(vi.mocked(listDir).mock.calls.length).toBe(calls + 1);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Permissions set to 750 on 1 item",
    );
  });

  it("derives the focused entry and the action targets", () => {
    usePaneStore.getState().setSelection("local", {
      selection: ["/home/alice/notes.txt"],
      anchor: "/home/alice/notes.txt",
      cursor: "/home/alice/notes.txt",
    });
    expect(focusedEntry(pane())?.name).toBe("notes.txt");
    expect(actionTargets(pane()).map((e) => e.name)).toEqual(["notes.txt"]);
    usePaneStore.getState().setSelection("local", {
      selection: [],
      anchor: null,
      cursor: "/home/alice/untitled folder",
    });
    expect(focusedEntry(pane())).toBeNull();
    expect(actionTargets(pane()).map((e) => e.name)).toEqual([
      "untitled folder",
    ]);
  });
  it("restores another tab in one pane and drops what was in flight there", async () => {
    vi.clearAllMocks();
    await usePaneStore.getState().open("remote", remote, "/srv");
    let answer: (entries: Entry[]) => void = () => {};
    vi.mocked(listDir).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const opening = usePaneStore.getState().open("local", local, "/slow");
    usePaneStore.getState().restore("local", {
      ...initialPane(),
      target: local,
      path: "/home/bob",
      loading: true,
    });
    answer([file("/slow/late.txt")]);
    await opening;
    expect(pane().path).toBe("/home/bob");
    // A snapshot taken mid-listing must not keep spinning.
    expect(pane().loading).toBe(false);
    // The other pane is not touched.
    expect(pane("remote").path).toBe("/srv");
    // The interrupted open did not carry on into the home folder.
    expect(homeDir).not.toHaveBeenCalled();
  });

  it("stops an open whose pane was closed meanwhile", async () => {
    vi.clearAllMocks();
    let home: (path: string) => void = () => {};
    vi.mocked(homeDir).mockImplementationOnce(
      () => new Promise((resolve) => (home = resolve)),
    );
    const opening = usePaneStore.getState().open("remote", remote, null);
    usePaneStore.getState().close("remote");
    home("/home/alice");
    await opening;
    expect(pane("remote").target).toBeNull();
    expect(listDir).not.toHaveBeenCalled();
  });
});
