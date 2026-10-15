import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import { invoke } from "@tauri-apps/api/core";

import {
  getSettings,
  saveSettings,
  toIpcError,
  windowConfirmClose,
} from "./commands";
import type { IrisSettings } from "./types";

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
