/**
 * Wire types for the Tauri IPC bridge.
 *
 * These mirror the serde shapes in `src-tauri` / `iris-core` exactly — change
 * them only in lockstep with the Rust side:
 * - Ids are plain UUID strings (`#[serde(transparent)]`).
 * - Structs are camelCase (`rename_all = "camelCase"`).
 */

/** Persisted backend settings (`iris_core::IrisSettings`). */
export interface IrisSettings {
  /** How many file transfers run at once (1–16). */
  parallelTransfers: number;
  /** How often a dropped connection is retried (0–20; 0 = never). */
  reconnectAttempts: number;
  /** Lower-case extension without the dot → app path to open it with. */
  editorOverrides: Record<string, string>;
}

/** Structured error every IPC command can reject with (`IpcError`). */
export interface IpcError {
  /** Human-readable, sanitized description. */
  message: string;
  /** Stable machine-readable category, e.g. `"invalidInput"`. */
  kind: string;
}
