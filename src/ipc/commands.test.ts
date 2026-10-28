import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import { invoke } from "@tauri-apps/api/core";

import {
  answerHostKey,
  cancelBatch,
  cancelTransfer,
  chmod,
  clearFinished,
  clearSecret,
  cancelDragOut,
  closeEdit,
  connect,
  finishDragOut,
  prepareDragOut,
  listEdits,
  openLocal,
  openRemote,
  resolveEdit,
  revealLocal,
  enqueueTransfers,
  hasActiveTransfers,
  listTransfers,
  reconnect,
  resolveConflict,
  retryTransfer,
  deletePaths,
  deleteProfile,
  disconnect,
  getSettings,
  homeDir,
  listDir,
  listProfiles,
  listSshConfigHosts,
  mkdir,
  preview,
  readLink,
  reorderProfiles,
  rename,
  saveProfile,
  saveSettings,
  setSecret,
  stat,
  toIpcError,
  windowConfirmClose,
} from "./commands";
import type { FsTarget, IrisSettings, TransferRequest } from "./types";

describe("IPC commands", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("passes settings under the camelCase `settings` key", async () => {
    const settings: IrisSettings = {
      parallelTransfers: 4,
      reconnectAttempts: 5,
      editorOverrides: { md: "/Applications/Example.app" },
      syncExcludes: [".git"],
    };
    await saveSettings(settings);
    expect(invoke).toHaveBeenCalledWith("save_settings", { settings });
  });

  it("names the read and close commands like the Rust handlers", async () => {
    await getSettings();
    await windowConfirmClose();
    expect(invoke).toHaveBeenCalledWith("get_settings");
    expect(invoke).toHaveBeenCalledWith("window_confirm_close");
  });
});

describe("connection and session commands", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("passes profiles and ids under camelCase keys", async () => {
    const profile = {
      name: "Example",
      host: "sftp.example.test",
      user: "demo",
      auth: { kind: "password" as const },
    };
    await listProfiles();
    await saveProfile(profile);
    await deleteProfile("p-1");
    await reorderProfiles(["p-2", "p-1"]);
    expect(invoke).toHaveBeenCalledWith("list_profiles");
    expect(invoke).toHaveBeenCalledWith("save_profile", { profile });
    expect(invoke).toHaveBeenCalledWith("delete_profile", { id: "p-1" });
    expect(invoke).toHaveBeenCalledWith("reorder_profiles", {
      ids: ["p-2", "p-1"],
    });
  });

  it("sends absent secrets as null and remember as false", async () => {
    await connect("p-1");
    expect(invoke).toHaveBeenCalledWith("connect", {
      profileId: "p-1",
      password: null,
      passphrase: null,
      remember: false,
    });
    await connect("p-1", { password: "example-only", remember: true });
    expect(invoke).toHaveBeenCalledWith("connect", {
      profileId: "p-1",
      password: "example-only",
      passphrase: null,
      remember: true,
    });
  });

  it("names the secret and ssh config commands like the Rust handlers", async () => {
    await setSecret("p-1", "passphrase", "example-only");
    await clearSecret("p-1", "password");
    await listSshConfigHosts();
    expect(invoke).toHaveBeenCalledWith("set_secret", {
      profileId: "p-1",
      kind: "passphrase",
      value: "example-only",
    });
    expect(invoke).toHaveBeenCalledWith("clear_secret", {
      profileId: "p-1",
      kind: "password",
    });
    expect(invoke).toHaveBeenCalledWith("list_ssh_config_hosts");
  });

  it("reconnects the same session with optional secrets", async () => {
    await reconnect("s-1");
    expect(invoke).toHaveBeenCalledWith("reconnect", {
      sessionId: "s-1",
      password: null,
      passphrase: null,
      remember: false,
    });
    await reconnect("s-1", { passphrase: "example-only", remember: true });
    expect(invoke).toHaveBeenCalledWith("reconnect", {
      sessionId: "s-1",
      password: null,
      passphrase: "example-only",
      remember: true,
    });
  });

  it("names the session commands like the Rust handlers", async () => {
    await disconnect("s-1");
    await answerHostKey("r-1", true);
    expect(invoke).toHaveBeenCalledWith("disconnect", { sessionId: "s-1" });
    expect(invoke).toHaveBeenCalledWith("answer_host_key", {
      requestId: "r-1",
      trust: true,
    });
  });

  it("passes the browsing target through as is", async () => {
    const target: FsTarget = { kind: "remote", sessionId: "s-1" };
    await listDir(target, "/srv");
    await stat({ kind: "local" }, "/tmp");
    await readLink(target, "/srv/link");
    await homeDir(target);
    expect(invoke).toHaveBeenCalledWith("list_dir", { target, path: "/srv" });
    expect(invoke).toHaveBeenCalledWith("stat", {
      target: { kind: "local" },
      path: "/tmp",
    });
    expect(invoke).toHaveBeenCalledWith("read_link", {
      target,
      path: "/srv/link",
    });
    expect(invoke).toHaveBeenCalledWith("home_dir", { target });
  });
});

describe("file operation commands", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());
  const target: FsTarget = { kind: "remote", sessionId: "s-1" };

  it("names the commands like the Rust handlers with camelCase keys", async () => {
    await mkdir(target, "/srv/new");
    await rename(target, "/srv/a", "/srv/b");
    await deletePaths(target, ["/srv/a", "/srv/b"]);
    await preview(target, "/srv/a.txt", 1024);
    expect(invoke).toHaveBeenCalledWith("mkdir", { target, path: "/srv/new" });
    expect(invoke).toHaveBeenCalledWith("rename", {
      target,
      from: "/srv/a",
      to: "/srv/b",
    });
    expect(invoke).toHaveBeenCalledWith("delete", {
      target,
      paths: ["/srv/a", "/srv/b"],
    });
    expect(invoke).toHaveBeenCalledWith("preview", {
      target,
      path: "/srv/a.txt",
      maxBytes: 1024,
    });
  });

  it("sends chmod non-recursive unless asked", async () => {
    await chmod(target, ["/srv/a"], 0o755);
    expect(invoke).toHaveBeenLastCalledWith("chmod", {
      target,
      paths: ["/srv/a"],
      mode: 0o755,
      recursive: false,
    });
    await chmod(target, ["/srv/d"], 0o700, true);
    expect(invoke).toHaveBeenLastCalledWith("chmod", {
      target,
      paths: ["/srv/d"],
      mode: 0o700,
      recursive: true,
    });
  });
});

describe("transfer commands", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("passes the request under the camelCase `request` key", async () => {
    const request: TransferRequest = {
      sessionId: "s-1",
      direction: "upload",
      items: [{ src: "/home/demo/report.pdf" }],
      dstDir: "/srv/uploads",
    };
    await enqueueTransfers(request);
    expect(invoke).toHaveBeenCalledWith("enqueue_transfers", { request });
  });

  it("names the job commands like the Rust handlers", async () => {
    await cancelTransfer("t-1");
    await retryTransfer("t-2");
    expect(invoke).toHaveBeenCalledWith("retry_transfer", { jobId: "t-2" });
    await cancelBatch("b-1");
    await listTransfers();
    await clearFinished();
    await hasActiveTransfers();
    expect(invoke).toHaveBeenCalledWith("cancel_transfer", { jobId: "t-1" });
    expect(invoke).toHaveBeenCalledWith("cancel_batch", { batchId: "b-1" });
    expect(invoke).toHaveBeenCalledWith("list_transfers");
    expect(invoke).toHaveBeenCalledWith("clear_finished");
    expect(invoke).toHaveBeenCalledWith("has_active_transfers");
  });

  it("sends applyToAll false unless asked", async () => {
    await resolveConflict("t-1", "keepBoth");
    expect(invoke).toHaveBeenLastCalledWith("resolve_conflict", {
      jobId: "t-1",
      resolution: "keepBoth",
      applyToAll: false,
    });
    await resolveConflict("t-2", "replace", true);
    expect(invoke).toHaveBeenLastCalledWith("resolve_conflict", {
      jobId: "t-2",
      resolution: "replace",
      applyToAll: true,
    });
  });
});

describe("toIpcError", () => {
  it("keeps a structured IpcError as is", () => {
    const err = { kind: "invalidInput", message: "bad" };
    expect(toIpcError(err)).toBe(err);
  });

  it("wraps anything else as kind unknown", () => {
    expect(toIpcError(new Error("boom"))).toEqual({
      kind: "unknown",
      message: "boom",
    });
    expect(toIpcError("nope")).toEqual({ kind: "unknown", message: "nope" });
  });
});

describe("remote edit commands", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("names the commands and keys like the Rust handlers", async () => {
    await openRemote("s-1", "/srv/notes.txt");
    await resolveEdit("e-1", "saveCopy");
    await listEdits();
    await closeEdit("e-1");
    expect(invoke).toHaveBeenCalledWith("open_remote", {
      sessionId: "s-1",
      path: "/srv/notes.txt",
    });
    expect(invoke).toHaveBeenCalledWith("resolve_edit", {
      editId: "e-1",
      resolution: "saveCopy",
    });
    expect(invoke).toHaveBeenCalledWith("list_edits");
    expect(invoke).toHaveBeenCalledWith("close_edit", { editId: "e-1" });
  });
});

describe("local open commands", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("names the commands and keys like the Rust handlers", async () => {
    await openLocal("/Users/alice/data.csv");
    await openLocal("/Users/alice/data.csv", true);
    await revealLocal("/Users/alice");
    expect(invoke).toHaveBeenCalledWith("open_local", {
      path: "/Users/alice/data.csv",
      useDefault: false,
    });
    expect(invoke).toHaveBeenCalledWith("open_local", {
      path: "/Users/alice/data.csv",
      useDefault: true,
    });
    expect(invoke).toHaveBeenCalledWith("reveal_local", {
      path: "/Users/alice",
    });
  });
});

describe("drag-out commands", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("names the commands and keys like the Rust handlers", async () => {
    await prepareDragOut("d-1", "s-1", ["/srv/report.pdf"]);
    await cancelDragOut("d-1");
    await finishDragOut("d-1", true);
    expect(invoke).toHaveBeenCalledWith("prepare_drag_out", {
      dragId: "d-1",
      sessionId: "s-1",
      paths: ["/srv/report.pdf"],
    });
    expect(invoke).toHaveBeenCalledWith("cancel_drag_out", { dragId: "d-1" });
    expect(invoke).toHaveBeenCalledWith("finish_drag_out", {
      dragId: "d-1",
      dropped: true,
    });
  });
});
