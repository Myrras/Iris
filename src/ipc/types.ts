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

// ---------------------------------------------------------------------------
// Connections (`iris_core::connection`)
// ---------------------------------------------------------------------------

/** A saved connection's id (UUID string, `iris_core::ProfileId`). */
export type ProfileId = string;
/** A live session's id (UUID string, `iris_core::SessionId`). */
export type SessionId = string;
/** An open host key prompt's id (UUID string, `HostKeyRequestId`). */
export type HostKeyRequestId = string;

/**
 * How a profile authenticates (`iris_core::AuthMethod`), tagged by `kind`.
 * Never holds a secret: passwords and key passphrases are passed to
 * `connect` per attempt or remembered in the OS keychain.
 *
 * - `agent`: each identity of the running SSH agent in turn.
 * - `sshConfigHost`: everything as `~/.ssh/config` says for `alias`, at
 *   connect time (its HostName/User/Port win over the profile's fields; its
 *   IdentityFiles, then the agent; its ProxyJump unless `jump` is set).
 */
export type AuthMethod =
  | { kind: "password" }
  | { kind: "keyFile"; path: string }
  | { kind: "agent" }
  | { kind: "sshConfigHost"; alias: string };

/**
 * The jump host a profile is reached through (`iris_core::JumpHost`): another
 * saved connection, or a `~/.ssh/config` alias / `[user@]host[:port]`.
 */
export type JumpHost =
  { kind: "profile"; profileId: ProfileId } | { kind: "alias"; alias: string };

/** A saved connection (`iris_core::ConnectionProfile`). */
export interface ConnectionProfile {
  id: ProfileId;
  /** Display name; the backend fills in `user@host` when blank. */
  name: string;
  host: string;
  /** 1–65535; 22 by default. */
  port: number;
  user: string;
  auth: AuthMethod;
  /** Remote folder to open after connecting; `null` = the login folder. */
  startDir: string | null;
  /** Reach the host through this jump host; `null` = directly. */
  jump: JumpHost | null;
}

/**
 * What `saveProfile` accepts: a profile whose `id` (omit for a new one),
 * `port` (defaults to 22), `startDir` and `jump` are optional.
 */
export type ConnectionProfileInput = Omit<
  ConnectionProfile,
  "id" | "port" | "startDir" | "jump"
> & {
  id?: ProfileId;
  port?: number;
  startDir?: string | null;
  jump?: JumpHost | null;
};

/** Which remembered secret of a profile (`iris_core::SecretKind`). */
export type SecretKind = "password" | "passphrase";

/** One `~/.ssh/config` host, resolved (`iris_core::SshConfigHost`). */
export interface SshConfigHost {
  /** The name after `Host`. */
  alias: string;
  /** `HostName`; `null` when unset (the alias is then the host). */
  hostName: string | null;
  user: string | null;
  port: number | null;
  /** `IdentityFile`s, `~` and tokens expanded. */
  identityFiles: string[];
  /** Raw `ProxyJump` list; `null` when unset or `none`. */
  proxyJump: string | null;
}

// ---------------------------------------------------------------------------
// Browsing (`iris_core::fs`)
// ---------------------------------------------------------------------------

/** Which filesystem a browsing call addresses (`iris_core::FsTarget`). */
export type FsTarget =
  { kind: "local" } | { kind: "remote"; sessionId: SessionId };

/** What a symlink resolves to (`iris_core::LinkTargetKind`). */
export type LinkTargetKind = "file" | "dir";

/** What an entry is (`iris_core::EntryKind`), tagged by `type`. */
export type EntryKind =
  | { type: "file" }
  | { type: "dir" }
  /** Sockets, devices, fifos. */
  | { type: "other" }
  | {
      type: "symlink";
      /** Raw link text; `null` when it could not be read. */
      target: string | null;
      /** What the link resolves to; `null` when it is broken. */
      targetKind: LinkTargetKind | null;
    };

/** One file, folder or link in a listing (`iris_core::Entry`). */
export interface Entry {
  name: string;
  /** Full path; pass it back to `listDir` / `stat`. */
  path: string;
  kind: EntryKind;
  /** Bytes (of the link itself for a symlink); 0 when unknown. */
  size: number;
  /** Last modification in unix seconds; `null` when unknown. */
  mtime: number | null;
  /** Unix mode bits (type + permissions); `null` when unknown (Windows). */
  mode: number | null;
  /** Dotfile, or the Windows hidden attribute. */
  hidden: boolean;
}

// ---------------------------------------------------------------------------
// File operations and previews (`iris_core::fs`, `iris_core::preview`)
// ---------------------------------------------------------------------------

/** One path a batch operation could not handle (`iris_core::BatchFailure`). */
export interface BatchFailure {
  path: string;
  /** The error kind, as an `IpcError` would carry it. */
  kind: string;
  /** App-owned, sanitized text. */
  message: string;
}

/**
 * Outcome of `delete` / `chmod` over several paths (`iris_core::BatchReport`):
 * one failure does not stop the others.
 */
export interface BatchReport {
  succeeded: string[];
  failed: BatchFailure[];
}

/** A file preview (`iris_core::Preview`), tagged by `kind`. */
export type Preview =
  | {
      kind: "text";
      text: string;
      /** Only the start of the file is in `text`. */
      truncated: boolean;
      totalSize: number;
    }
  | {
      kind: "image";
      /** `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/svg+xml`. */
      mime: string;
      dataBase64: string;
      totalSize: number;
    }
  | { kind: "binary"; totalSize: number }
  /** An image larger than the preview size limit. */
  | { kind: "tooLarge"; totalSize: number };

// ---------------------------------------------------------------------------
// Session events (`iris_core::CoreEvent`)
// ---------------------------------------------------------------------------

/** Lifecycle of one session (`iris_core::SessionState`). */
export type SessionState = "connecting" | "connected" | "disconnected";

/**
 * Payload of `session:host-key-prompt`: a connect reached a server whose key
 * is not in `known_hosts` and waits for `answerHostKey(requestId, trust)`.
 */
export interface HostKeyPromptEvent {
  type: "hostKeyPrompt";
  requestId: HostKeyRequestId;
  /** The connect this prompt belongs to. */
  sessionId: SessionId;
  host: string;
  port: number;
  /** SSH algorithm name, e.g. `ssh-ed25519`. */
  keyType: string;
  /** OpenSSH-style `SHA256:<base64>` fingerprint. */
  fingerprintSha256: string;
}

/** Payload of `session:state-changed`. */
export interface SessionStateChangedEvent {
  type: "sessionStateChanged";
  sessionId: SessionId;
  profileId: ProfileId;
  state: SessionState;
  /**
   * Set on a `disconnected` the user did not ask for (failed connect,
   * dropped connection); app-owned text.
   */
  reason: string | null;
}

/**
 * Every `IpcError.kind` the backend produces (`CoreError::kind` plus the
 * IPC-only ones). `IpcError.kind` stays `string` so unknown kinds degrade
 * gracefully.
 */
export type IpcErrorKind =
  | "io"
  | "config"
  | "invalidInput"
  | "notFound"
  | "alreadyExists"
  | "permissionDenied"
  | "connectFailed"
  | "authFailed"
  | "passwordRequired"
  | "passphraseRequired"
  | "keyFile"
  | "agent"
  | "keychain"
  | "jumpHost"
  | "hostKeyChanged"
  | "hostKeyRejected"
  | "notConnected"
  | "remote"
  | "unknown";
