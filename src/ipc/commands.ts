/**
 * Typed wrappers over every Tauri IPC command.
 *
 * All command rejections are `IpcError` shapes from the Rust side;
 * `toIpcError` normalizes anything else (bridge failures, plugin errors) into
 * the same shape so callers have exactly one error type to handle.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  BatchReport,
  ConnectionProfile,
  ConnectionProfileInput,
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

/** Close a session (a no-op when it is already gone). */
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
// Window
// ---------------------------------------------------------------------------

/** Confirm quitting despite active work: arms the force-close flag and exits. */
export function windowConfirmClose(): Promise<void> {
  return invoke("window_confirm_close");
}
