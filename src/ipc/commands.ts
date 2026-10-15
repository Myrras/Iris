/**
 * Typed wrappers over every Tauri IPC command.
 *
 * All command rejections are `IpcError` shapes from the Rust side;
 * `toIpcError` normalizes anything else (bridge failures, plugin errors) into
 * the same shape so callers have exactly one error type to handle.
 */

import { invoke } from "@tauri-apps/api/core";

import type { IpcError, IrisSettings } from "./types";

/** Narrow an unknown rejection to the structured `IpcError` shape. */
export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IpcError).message === "string" &&
    typeof (value as IpcError).kind === "string"
  );
}

/** Coerce any rejection into an `IpcError` (kind `"unknown"` as fallback). */
export function toIpcError(value: unknown): IpcError {
  if (isIpcError(value)) return value;
  if (value instanceof Error)
    return { message: value.message, kind: "unknown" };
  return { message: String(value), kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The persisted backend settings (`settings.json`). */
export function getSettings(): Promise<IrisSettings> {
  return invoke("get_settings");
}

/**
 * Replace the backend settings; resolves with what was stored (normalized),
 * rejects with an `invalidInput` `IpcError` for out-of-range values.
 */
export function saveSettings(settings: IrisSettings): Promise<IrisSettings> {
  return invoke("save_settings", { settings });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** Confirm quitting despite active work: arms the force-close flag and exits. */
export function windowConfirmClose(): Promise<void> {
  return invoke("window_confirm_close");
}
