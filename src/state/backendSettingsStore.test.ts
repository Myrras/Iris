import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock("./toastStore", () => ({ toastError: vi.fn() }));

import { getSettings, saveSettings } from "../ipc/commands";
import type { IrisSettings } from "../ipc/types";
import { useBackendSettingsStore } from "./backendSettingsStore";
import { toastError } from "./toastStore";

const stored: IrisSettings = {
  parallelTransfers: 4,
  reconnectAttempts: 3,
  editorOverrides: {},
  syncExcludes: [".git"],
};

beforeEach(() => {
  vi.clearAllMocks();
  useBackendSettingsStore.setState({ settings: null });
});

describe("backendSettingsStore", () => {
  it("loads and saves a patch over the stored settings", async () => {
    vi.mocked(getSettings).mockResolvedValue(stored);
    vi.mocked(saveSettings).mockImplementation(async (s) => s);
    await useBackendSettingsStore.getState().load();
    await useBackendSettingsStore.getState().save({ parallelTransfers: 8 });
    expect(saveSettings).toHaveBeenCalledWith({
      ...stored,
      parallelTransfers: 8,
    });
    expect(useBackendSettingsStore.getState().settings?.parallelTransfers).toBe(
      8,
    );
  });

  it("reports a rejected save and re-reads the stored value", async () => {
    vi.mocked(getSettings).mockResolvedValue(stored);
    vi.mocked(saveSettings).mockRejectedValue({
      kind: "invalidInput",
      message: "parallel transfers must be 1–16",
    });
    await useBackendSettingsStore.getState().load();
    await useBackendSettingsStore.getState().save({ parallelTransfers: 99 });
    expect(toastError).toHaveBeenCalledWith(
      "Could not save the settings",
      "parallel transfers must be 1–16",
    );
    expect(useBackendSettingsStore.getState().settings).toEqual(stored);
  });
});
