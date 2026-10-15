import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import { invoke } from "@tauri-apps/api/core";

import {
  answerHostKey,
  clearSecret,
  connect,
  deleteProfile,
  disconnect,
  getSettings,
  homeDir,
  listDir,
  listProfiles,
  listSshConfigHosts,
  readLink,
  saveProfile,
  saveSettings,
  setSecret,
  stat,
  toIpcError,
  windowConfirmClose,
} from "./commands";
import type { FsTarget, IrisSettings } from "./types";

describe("IPC commands", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("passes settings under the camelCase `settings` key", async () => {
    const settings: IrisSettings = {
      parallelTransfers: 4,
      reconnectAttempts: 5,
      editorOverrides: { md: "/Applications/Example.app" },
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
    expect(invoke).toHaveBeenCalledWith("list_profiles");
    expect(invoke).toHaveBeenCalledWith("save_profile", { profile });
    expect(invoke).toHaveBeenCalledWith("delete_profile", { id: "p-1" });
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
