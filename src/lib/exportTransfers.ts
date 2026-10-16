/**
 * "Export CSV…" in the Transfers header: pick where to save with the native
 * save dialog, let the core write the list (`exportTransfersCsv`), then
 * toast the result with a "Show in Finder" (Explorer / File Manager)
 * action.
 */

import { exportTransfersCsv, toIpcError } from "../ipc/commands";
import { toastError, useToastStore } from "../state/toastStore";
import { fileManagerName, revealLocalPath } from "./openLocal";
import { baseName } from "./path";

/** `iris-transfers-2026-10-16-1403.csv` for `now` (local time). */
export function defaultExportName(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `iris-transfers-${day}-${two(now.getHours())}${two(now.getMinutes())}.csv`;
}

/** Ask where to save, write the CSV; `false` when nothing was written. */
export async function exportTransfers(): Promise<boolean> {
  let picked: string | null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    picked = await save({
      title: "Export transfers",
      defaultPath: defaultExportName(),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
  } catch (e) {
    toastError("Could not open the save dialog", toIpcError(e).message);
    return false;
  }
  if (!picked) return false;
  try {
    const report = await exportTransfersCsv(picked, "all");
    useToastStore.getState().push({
      kind: "success",
      message: `Exported ${report.rows} ${report.rows === 1 ? "transfer" : "transfers"}`,
      detail: baseName(report.path),
      action: {
        label: `Show in ${fileManagerName}`,
        onClick: () => void revealLocalPath(report.path),
      },
    });
    return true;
  } catch (e) {
    toastError("Could not export the transfers", toIpcError(e).message);
    return false;
  }
}
