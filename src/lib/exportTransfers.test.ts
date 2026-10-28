import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  exportTransfersCsv: vi.fn(),
  revealLocal: vi.fn(() => Promise.resolve()),
}));

import { save } from "@tauri-apps/plugin-dialog";

import { exportTransfersCsv, revealLocal } from "../ipc/commands";
import { useToastStore } from "../state/toastStore";
import { defaultExportName, exportTransfers } from "./exportTransfers";

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
});

describe("exportTransfers", () => {
  it("names the file after the local date and time", () => {
    expect(defaultExportName(new Date(2026, 9, 6, 9, 5))).toBe(
      "iris-transfers-2026-10-06-0905.csv",
    );
  });

  it("asks where to save, writes the CSV and offers to show it", async () => {
    vi.mocked(save).mockResolvedValue("/home/alice/transfers.csv");
    vi.mocked(exportTransfersCsv).mockResolvedValue({
      path: "/home/alice/transfers.csv",
      rows: 3,
    });
    await expect(exportTransfers()).resolves.toBe(true);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(
          /^iris-transfers-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/,
        ),
        filters: [{ name: "CSV", extensions: ["csv"] }],
      }),
    );
    expect(exportTransfersCsv).toHaveBeenCalledWith(
      "/home/alice/transfers.csv",
      "all",
    );
    const toast = useToastStore.getState().toasts[0];
    expect(toast).toMatchObject({
      kind: "success",
      message: "Exported 3 transfers",
      detail: "transfers.csv",
    });
    expect(toast.action?.label).toMatch(/^Show in /);
    await toast.action!.onClick();
    expect(revealLocal).toHaveBeenCalledWith("/home/alice/transfers.csv");
  });

  it("does nothing when the dialog is cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);
    await expect(exportTransfers()).resolves.toBe(false);
    expect(exportTransfersCsv).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("says why the export failed", async () => {
    vi.mocked(save).mockResolvedValue("/locked/transfers.csv");
    vi.mocked(exportTransfersCsv).mockRejectedValue({
      kind: "permissionDenied",
      message: "permission denied: /locked/transfers.csv",
    });
    await expect(exportTransfers()).resolves.toBe(false);
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "error",
      message: "Could not export the transfers",
      detail: "permission denied: /locked/transfers.csv",
    });
  });
});
