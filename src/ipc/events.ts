/**
 * Typed wrappers over the global Tauri events emitted by `src-tauri`
 * (`events.rs` forwards core events; `lib.rs` emits the window/menu ones).
 * Events only say *what* changed — handlers re-pull data through `commands.ts`.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  DragOutProgressEvent,
  EditConflictEvent,
  EditFailedEvent,
  EditUploadedEvent,
  HostKeyPromptEvent,
  SessionStateChangedEvent,
  TransferConflictEvent,
  TransferJobChangedEvent,
  TransferProgressEvent,
} from "./types";

/** The persisted backend settings changed; re-pull them via `getSettings`. */
export function onSettingsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("settings:changed", () => handler());
}

/** The saved connections changed; re-pull them via `listProfiles`. */
export function onProfilesChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("profiles:changed", () => handler());
}

/**
 * A connect hit an unknown host key and waits for
 * `answerHostKey(requestId, trust)`. If the session turns `disconnected`
 * first (e.g. the prompt timed out), close the prompt.
 */
export function onHostKeyPrompt(
  handler: (event: HostKeyPromptEvent) => void,
): Promise<UnlistenFn> {
  return listen<HostKeyPromptEvent>("session:host-key-prompt", (e) =>
    handler(e.payload),
  );
}

/**
 * A session became `connecting`, `connected`, `reconnecting` (another
 * attempt, or its countdown) or `disconnected`.
 */
export function onSessionStateChanged(
  handler: (event: SessionStateChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionStateChangedEvent>("session:state-changed", (e) =>
    handler(e.payload),
  );
}

/**
 * The transfer list changed shape (jobs found while a folder is expanded,
 * finished jobs cleared, or events were dropped under load); re-pull it via
 * `listTransfers`.
 */
export function onTransfersUpdated(handler: () => void): Promise<UnlistenFn> {
  return listen("transfers:updated", () => handler());
}

/** One job changed state (or its destination, after `keepBoth`). */
export function onTransferJobChanged(
  handler: (event: TransferJobChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<TransferJobChangedEvent>("transfer:job-changed", (e) =>
    handler(e.payload),
  );
}

/** A running job copied more bytes (at most ten events a second per job). */
export function onTransferProgress(
  handler: (event: TransferProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgressEvent>("transfer:progress", (e) =>
    handler(e.payload),
  );
}

/**
 * A job's destination exists; ask the user and answer with
 * `resolveConflict(jobId, resolution, applyToAll)`.
 */
export function onTransferConflict(
  handler: (event: TransferConflictEvent) => void,
): Promise<UnlistenFn> {
  return listen<TransferConflictEvent>("transfer:conflict", (e) =>
    handler(e.payload),
  );
}

/** A save of a file open for editing reached the server. */
export function onEditUploaded(
  handler: (event: EditUploadedEvent) => void,
): Promise<UnlistenFn> {
  return listen<EditUploadedEvent>("edit:uploaded", (e) => handler(e.payload));
}

/**
 * A save found the server copy changed; ask the user and answer with
 * `resolveEdit(editId, resolution)`.
 */
export function onEditConflict(
  handler: (event: EditConflictEvent) => void,
): Promise<UnlistenFn> {
  return listen<EditConflictEvent>("edit:conflict", (e) => handler(e.payload));
}

/** Uploading a save failed; the next save tries again. */
export function onEditFailed(
  handler: (event: EditFailedEvent) => void,
): Promise<UnlistenFn> {
  return listen<EditFailedEvent>("edit:failed", (e) => handler(e.payload));
}

/** A drag out of the window downloaded more of its remote files. */
export function onDragOutProgress(
  handler: (event: DragOutProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<DragOutProgressEvent>("dragOut:progress", (e) =>
    handler(e.payload),
  );
}

/** The native macOS menu's Settings… item (⌘,) was activated (`lib.rs`). */
export function onMenuOpenSettings(handler: () => void): Promise<UnlistenFn> {
  return listen("menu:open-settings", () => handler());
}

/**
 * A close/quit was blocked because the core still has active work
 * (`lib.rs`). The frontend responds by showing the close-warning dialog.
 */
export function onWindowCloseRequested(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("window:close-requested", () => handler());
}
