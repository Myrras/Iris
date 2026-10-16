/**
 * Typed wrappers over every Tauri IPC command.
 *
 * All command rejections are `IpcError` shapes from the Rust side;
 * `toIpcError` normalizes anything else (bridge failures, plugin errors) into
 * the same shape so callers have exactly one error type to handle.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  BatchId,
  BatchReport,
  ConflictResolution,
  ConnectionProfile,
  ConnectionProfileInput,
  EditId,
  EditInfo,
  EditResolution,
  Entry,
  FsTarget,
  HostKeyRequestId,
  IpcError,
  IrisSettings,
  Preview,
  ProfileId,
  SecretKind,
  SessionId,
  SshConfigHost,
  TransferId,
  TransferList,
  TransferRequest,
} from "./types";

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
// Connections
// ---------------------------------------------------------------------------

/** All saved connections, in creation order. */
export function listProfiles(): Promise<ConnectionProfile[]> {
  return invoke("list_profiles");
}

/**
 * Create (no `id`) or replace (known `id`) a saved connection; resolves with
 * what was stored, rejects with `invalidInput`. Emits `profiles:changed`.
 */
export function saveProfile(
  profile: ConnectionProfileInput,
): Promise<ConnectionProfile> {
  return invoke("save_profile", { profile });
}

/**
 * Delete a saved connection and its remembered secrets; rejects with
 * `notFound` if it does not exist.
 */
export function deleteProfile(id: ProfileId): Promise<void> {
  return invoke("delete_profile", { id });
}

/**
 * Remember a password / key passphrase for a saved connection in the OS
 * keychain. Rejects with `notFound` or `keychain`.
 */
export function setSecret(
  profileId: ProfileId,
  kind: SecretKind,
  value: string,
): Promise<void> {
  return invoke("set_secret", { profileId, kind, value });
}

/** Forget a remembered secret (a no-op when none is stored). */
export function clearSecret(
  profileId: ProfileId,
  kind: SecretKind,
): Promise<void> {
  return invoke("clear_secret", { profileId, kind });
}

/** The concrete `~/.ssh/config` hosts, resolved, in file order. */
export function listSshConfigHosts(): Promise<SshConfigHost[]> {
  return invoke("list_ssh_config_hosts");
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Per-connect credentials. A secret left out is read from the keychain when
 * the login needs it; the given ones are stored there only with `remember`.
 */
export interface ConnectSecrets {
  /** For `password` profiles (else `passwordRequired` without a saved one). */
  password?: string;
  /** Only for an encrypted key file (else the connect rejects with `passphraseRequired`). */
  passphrase?: string;
  /** Store the given secrets in the keychain once the login succeeded. */
  remember?: boolean;
}

/**
 * Connect a saved profile; resolves with the session id once SFTP is ready.
 * An unknown host key first raises `session:host-key-prompt` and waits for
 * `answerHostKey`. Rejects with `authFailed`, `passwordRequired`,
 * `passphraseRequired`, `keyFile`, `agent`, `jumpHost`, `connectFailed`,
 * `hostKeyChanged`, `hostKeyRejected`, `notFound`, …
 */
export function connect(
  profileId: ProfileId,
  secrets: ConnectSecrets = {},
): Promise<SessionId> {
  return invoke("connect", {
    profileId,
    password: secrets.password ?? null,
    passphrase: secrets.passphrase ?? null,
    remember: secrets.remember ?? false,
  });
}

/**
 * Reconnect a session that dropped, under the same id (the "Retry" buttons).
 * While the core is still auto-reconnecting it skips the wait and tries now.
 * Secrets work as for `connect`. Publishes `connecting`, then `connected`
 * (its paused transfers resume) or `disconnected`. Rejects like `connect`,
 * and with `notConnected` for an unknown or user-closed session.
 */
export function reconnect(
  sessionId: SessionId,
  secrets: ConnectSecrets = {},
): Promise<void> {
  return invoke("reconnect", {
    sessionId,
    password: secrets.password ?? null,
    passphrase: secrets.passphrase ?? null,
    remember: secrets.remember ?? false,
  });
}

/**
 * Close a session (a no-op when it is already gone). Its unfinished
 * transfers are cancelled, so ask first when it has any.
 */
export function disconnect(sessionId: SessionId): Promise<void> {
  return invoke("disconnect", { sessionId });
}

/** Answer an open host key prompt: `trust` records the key and continues. */
export function answerHostKey(
  requestId: HostKeyRequestId,
  trust: boolean,
): Promise<void> {
  return invoke("answer_host_key", { requestId, trust });
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

/** The entries of a folder (unsorted). */
export function listDir(target: FsTarget, path: string): Promise<Entry[]> {
  return invoke("list_dir", { target, path });
}

/** One entry; a final symlink is reported, not followed. */
export function stat(target: FsTarget, path: string): Promise<Entry> {
  return invoke("stat", { target, path });
}

/** The raw target text of a symlink. */
export function readLink(target: FsTarget, path: string): Promise<string> {
  return invoke("read_link", { target, path });
}

/** The home folder (local) or login folder (remote), absolute. */
export function homeDir(target: FsTarget): Promise<string> {
  return invoke("home_dir", { target });
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/** Create a folder; rejects with `alreadyExists` when the name is taken. */
export function mkdir(target: FsTarget, path: string): Promise<void> {
  return invoke("mkdir", { target, path });
}

/**
 * Rename `from` to `to` (full paths). Never overwrites: rejects with
 * `alreadyExists` when `to` is taken.
 */
export function rename(
  target: FsTarget,
  from: string,
  to: string,
): Promise<void> {
  return invoke("rename", { target, from, to });
}

/**
 * Delete each path (folders with their contents, symlinks themselves).
 * Local entries go to the Trash; remote ones are deleted permanently.
 * Per-path failures come back in the report; a lost session rejects.
 */
export function deletePaths(
  target: FsTarget,
  paths: string[],
): Promise<BatchReport> {
  return invoke("delete", { target, paths });
}

/**
 * Set the permission bits (`0`–`0o7777`) of each path; `recursive` also
 * changes everything inside folders (symlinks skipped).
 */
export function chmod(
  target: FsTarget,
  paths: string[],
  mode: number,
  recursive = false,
): Promise<BatchReport> {
  return invoke("chmod", { target, paths, mode, recursive });
}

/** Preview a file, reading at most `maxBytes` (text at most 1 MiB). */
export function preview(
  target: FsTarget,
  path: string,
  maxBytes: number,
): Promise<Preview> {
  return invoke("preview", { target, path, maxBytes });
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/**
 * Queue an upload or download of `request.items` into `request.dstDir`;
 * resolves with the batch id at once. Folders are expanded in the
 * background (`transfers:updated`); each job then reports through
 * `transfer:job-changed`, `transfer:progress` and `transfer:conflict`.
 * Rejects with `notConnected` (unknown session) or `invalidInput` (no
 * items, empty path).
 */
export function enqueueTransfers(request: TransferRequest): Promise<BatchId> {
  return invoke("enqueue_transfers", { request });
}

/**
 * Cancel one job; a running one leaves its partial file. A finished job is
 * left as it is; rejects with `notFound` for an unknown id.
 */
export function cancelTransfer(jobId: TransferId): Promise<void> {
  return invoke("cancel_transfer", { jobId });
}

/** Cancel every unfinished job of a batch; rejects with `notFound`. */
export function cancelBatch(batchId: BatchId): Promise<void> {
  return invoke("cancel_batch", { batchId });
}

/**
 * Answer a `transfer:conflict`. With `applyToAll` the answer also decides
 * the batch's other waiting conflicts and every later one, without new
 * events. Rejects with `notFound`, or `invalidInput` when the job is not
 * waiting for a decision.
 */
export function resolveConflict(
  jobId: TransferId,
  resolution: ConflictResolution,
  applyToAll = false,
): Promise<void> {
  return invoke("resolve_conflict", { jobId, resolution, applyToAll });
}

/**
 * Queue a `failed` job again: a file starts over, a folder placeholder is
 * listed again. Rejects with `notFound`, `invalidInput` (not failed) or
 * `notConnected` (its session is not connected).
 */
export function retryTransfer(jobId: TransferId): Promise<void> {
  return invoke("retry_transfer", { jobId });
}

/** Every transfer job (in discovery order) and the totals. */
export function listTransfers(): Promise<TransferList> {
  return invoke("list_transfers");
}

/** Drop finished jobs (done, failed, cancelled, skipped) from the list. */
export function clearFinished(): Promise<void> {
  return invoke("clear_finished");
}

/** Whether any job is queued, running, waiting for an answer or paused. */
export function hasActiveTransfers(): Promise<boolean> {
  return invoke("has_active_transfers");
}

// ---------------------------------------------------------------------------
// Remote edit
// ---------------------------------------------------------------------------

/**
 * Download a remote file and open it in the editor set for its extension
 * (Settings → Editors) or the OS default; resolves with the edit id. Every
 * save is uploaded (`edit:uploaded`), or raises `edit:conflict` when the
 * server copy changed meanwhile. A file already open is shown again.
 * Rejects with `notConnected`, `notFound`, `invalidInput` (a folder) or
 * `config` (no editor could be opened).
 */
export function openRemote(
  sessionId: SessionId,
  path: string,
): Promise<EditId> {
  return invoke("open_remote", { sessionId, path });
}

/**
 * Answer an `edit:conflict`: `overwrite` uploads the local copy anyway,
 * `discard` reloads the server copy over it, `saveCopy` uploads it as
 * `name (edited).ext` next to the original. Rejects with `notFound`, or
 * `invalidInput` when the edit is not waiting for an answer.
 */
export function resolveEdit(
  editId: EditId,
  resolution: EditResolution,
): Promise<void> {
  return invoke("resolve_edit", { editId, resolution });
}

/** Every file open for editing. */
export function listEdits(): Promise<EditInfo[]> {
  return invoke("list_edits");
}

/** Stop editing a file and delete its local copy; rejects with `notFound`. */
export function closeEdit(editId: EditId): Promise<void> {
  return invoke("close_edit", { editId });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Confirm quitting despite active work: cancels every transfer, arms the
 * force-close flag and exits.
 */
export function windowConfirmClose(): Promise<void> {
  return invoke("window_confirm_close");
}
