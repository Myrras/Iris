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
  /**
   * Name patterns a sync never copies or deletes, matched per path segment
   * (`*` and `?` wildcards). Default `.git`, `.DS_Store`, `node_modules`,
   * `Thumbs.db`.
   */
  syncExcludes: string[];
  /**
   * Favorite local folders, in the user's order. Changed only through
   * `setLocalFavorites`: `saveSettings` keeps the stored list.
   */
  localFavorites: Favorite[];
}

/**
 * A favorite folder (`iris_core::Favorite`). `path` is absolute (remote:
 * from `/`); `label` is shown instead of the folder's name, `null` = derived
 * from the path.
 */
export interface Favorite {
  path: string;
  label: string | null;
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
  /**
   * Favorite remote folders, in the user's order. Changed only through
   * `setProfileFavorites`: `saveProfile` keeps the stored list.
   */
  favorites: Favorite[];
}

/**
 * What `saveProfile` accepts: a profile whose `id` (omit for a new one),
 * `port` (defaults to 22), `startDir` and `jump` are optional. Its
 * favorites are not the form's: the backend keeps the stored ones.
 */
export type ConnectionProfileInput = Omit<
  ConnectionProfile,
  "id" | "port" | "startDir" | "jump" | "favorites"
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
// Transfers (`iris_core::transfer`)
// ---------------------------------------------------------------------------

/** One transfer job's id (UUID string, `iris_core::TransferId`). */
export type TransferId = string;
/** The jobs of one `enqueueTransfers` call (UUID string, `BatchId`). */
export type BatchId = string;

/** `upload` = local → remote, `download` = remote → local. */
export type TransferDirection = "upload" | "download";

/**
 * Where a job is (`iris_core::TransferState`):
 *
 * - `queued` → `running` when a slot is free (`parallelTransfers`).
 * - `running` → `done` | `failed` | `skipped` | `needsDecision` | `paused`
 *   | `cancelled`.
 * - `needsDecision`: the destination exists; `resolveConflict` → `queued`.
 * - `paused`: the connection dropped; progress is kept (resumed after a
 *   reconnect).
 * - Any unfinished state → `cancelled` via `cancelTransfer` / `cancelBatch`.
 * - `done`, `failed`, `cancelled`, `skipped` are final.
 */
export type TransferState =
  | "queued"
  | "running"
  | "needsDecision"
  | "paused"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

/** Why a job failed, or why Iris skipped it (`iris_core::TransferError`). */
export interface TransferError {
  /** An `IpcErrorKind`, e.g. `"notFound"`, `"permissionDenied"`. */
  kind: string;
  /** App-owned, sanitized text. */
  message: string;
}

/** One file being copied (`iris_core::TransferJob`). */
export interface TransferJob {
  id: TransferId;
  batchId: BatchId;
  sessionId: SessionId;
  direction: TransferDirection;
  /** Full source path (local for uploads, remote for downloads). */
  src: string;
  /** Full destination path; changes after a `keepBoth` answer. */
  dst: string;
  /** Source size in bytes (refreshed when the job starts). */
  size: number;
  bytesDone: number;
  state: TransferState;
  /**
   * Set when `failed`, and when `skipped` by Iris itself (a link to a
   * folder, a broken link, a socket/device, an unsafe name). `null` for a
   * `skip` answer.
   */
  error: TransferError | null;
  /**
   * A placeholder for a folder (or selected item) that could not be listed
   * or made (`failed`): retrying counts it again, and the placeholder is
   * replaced by its file jobs.
   */
  folder: boolean;
  /** When it first started copying, unix ms; `null` before (reset by a retry). */
  startedAt: number | null;
  /** When it reached a final state, unix ms. */
  finishedAt: number | null;
}

/** Which jobs `exportTransfersCsv` writes (`iris_core::ExportScope`). */
export type ExportScope = "all" | "finished";

/** What `exportTransfersCsv` wrote (`iris_core::ExportReport`). */
export interface ExportReport {
  path: string;
  /** Jobs written (the header not counted). */
  rows: number;
}

/** One selected file or folder (`iris_core::TransferItem`). */
export interface TransferItem {
  /** Full path on the source side. */
  src: string;
}

/** What `enqueueTransfers` takes (`iris_core::TransferRequest`). */
export interface TransferRequest {
  /** The remote side. */
  sessionId: SessionId;
  direction: TransferDirection;
  items: TransferItem[];
  /** The folder on the destination side the items are copied into. */
  dstDir: string;
}

/**
 * The answer to a conflict (`iris_core::ConflictResolution`):
 *
 * - `replace`: overwrite the destination.
 * - `skip`: leave it; the job ends `skipped`.
 * - `keepBoth`: copy to the first free `name (2).ext`, `name (3).ext`, …
 * - `resume`: append the rest to a shorter destination. An equal-sized one
 *   counts as done (untouched); a larger one is replaced.
 */
export type ConflictResolution = "replace" | "skip" | "keepBoth" | "resume";

/** Totals over the listed jobs (`iris_core::TransferSummary`). */
export interface TransferSummary {
  /** Bytes of all jobs except skipped and cancelled ones. */
  totalBytes: number;
  doneBytes: number;
  /** All transfers together, over the last few seconds. */
  bytesPerSec: number;
  /** Running jobs. */
  active: number;
  /** Jobs waiting for a slot. */
  queued: number;
  /** Jobs waiting for a conflict answer. */
  needsDecision: number;
  paused: number;
  /**
   * Seconds until every unfinished job is done at the current speed;
   * `null` while a batch is still counting or nothing moves.
   */
  etaSecs: number | null;
}

/**
 * Where a batch is: counting what it will copy (no jobs yet), copying, or
 * finished (`iris_core::BatchPhase`).
 */
export type BatchPhase = "counting" | "transferring" | "done";

/** One batch in `listTransfers` (`iris_core::BatchInfo`). */
export interface BatchInfo {
  batchId: BatchId;
  sessionId: SessionId;
  direction: TransferDirection;
  phase: BatchPhase;
  /** Counting waits for the connection to come back. */
  paused: boolean;
  /** What the count found (so far, while counting). */
  countedFiles: number;
  countedBytes: number;
  countedFolders: number;
  /** Its jobs (skipped, cancelled and placeholders left out); 0 while counting. */
  totalFiles: number;
  totalBytes: number;
  doneFiles: number;
  doneBytes: number;
}

/** What `listTransfers` returns (`iris_core::TransferList`). */
export interface TransferList {
  /** In the order they were found. */
  jobs: TransferJob[];
  /** In the order they were started. */
  batches: BatchInfo[];
  summary: TransferSummary;
}

/**
 * Payload of `transfer:batch-counting`: what a batch's count found so far
 * (at most ten a second, and once more at the end).
 */
export interface BatchCountingEvent {
  type: "batchCounting";
  batchId: BatchId;
  files: number;
  bytes: number;
  folders: number;
}

/** One side of a conflict (`iris_core::ConflictSide`). */
export interface ConflictSide {
  path: string;
  size: number;
  /** Unix seconds; `null` when unknown. */
  mtime: number | null;
}

/** Payload of `transfer:job-changed`: a job changed state or destination. */
export interface TransferJobChangedEvent {
  type: "transferJobChanged";
  job: TransferJob;
}

/** Payload of `transfer:progress` (at most ten per second per job). */
export interface TransferProgressEvent {
  type: "transferProgress";
  jobId: TransferId;
  batchId: BatchId;
  bytesDone: number;
  size: number;
  /** Over the last few seconds. */
  bytesPerSec: number;
}

/**
 * Payload of `transfer:conflict`: the job waits (`needsDecision`) for
 * `resolveConflict`. Not raised once the batch has an apply-to-all answer.
 */
export interface TransferConflictEvent {
  type: "transferConflict";
  batchId: BatchId;
  jobId: TransferId;
  src: ConflictSide;
  dst: ConflictSide;
}

// ---------------------------------------------------------------------------
// Remote edit (`iris_core::edit`)
// ---------------------------------------------------------------------------

/** One remote file open in a local editor (UUID string, `EditId`). */
export type EditId = string;

/** The answer to an `edit:conflict` (`iris_core::EditResolution`). */
export type EditResolution = "overwrite" | "discard" | "saveCopy";

/** Where an edit is (`iris_core::EditStatus`). */
export type EditStatus =
  "synced" | "uploading" | "waitingForConnection" | "conflict" | "failed";

/** A remote file's size and mtime (`iris_core::RemoteStamp`). */
export interface RemoteStamp {
  size: number;
  /** Unix seconds; `null` when unknown. */
  mtime: number | null;
}

/** What `listEdits` returns per file (`iris_core::EditInfo`). */
export interface EditInfo {
  id: EditId;
  sessionId: SessionId;
  /** The remote file saves go to (the edited copy's after `saveCopy`). */
  path: string;
  name: string;
  /** The local copy the editor has open. */
  localPath: string;
  status: EditStatus;
  /** The server copy as of the last download or upload. */
  baseline: RemoteStamp;
}

/** Payload of `edit:uploaded`: a save reached the server as `path`. */
export interface EditUploadedEvent {
  type: "editUploaded";
  editId: EditId;
  sessionId: SessionId;
  path: string;
}

/**
 * Payload of `edit:conflict`: the server copy changed since it was opened
 * (`remote` is `null` when it was deleted). The edit waits for `resolveEdit`.
 */
export interface EditConflictEvent {
  type: "editConflict";
  editId: EditId;
  sessionId: SessionId;
  path: string;
  remote: RemoteStamp | null;
  baseline: RemoteStamp;
}

/** Payload of `edit:failed`: an upload failed; the next save tries again. */
export interface EditFailedEvent {
  type: "editFailed";
  editId: EditId;
  sessionId: SessionId;
  path: string;
  kind: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Session events (`iris_core::CoreEvent`)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one session (`iris_core::SessionState`), tagged by `status`.
 *
 * - `reconnecting`: the connection dropped and the core retries it under the
 *   same session id (backoff 1/2/4/8/16 s). Published before each wait with
 *   `nextRetryInSecs` = the wait, and with `0` while that attempt runs.
 * - `disconnected`: `reason` is app-owned text for a drop, a failed connect
 *   or a reconnect that gave up; `null` when the user asked for it.
 */
export type SessionState =
  | { status: "connecting" }
  | { status: "connected" }
  | {
      status: "reconnecting";
      /** 1-based. */
      attempt: number;
      maxAttempts: number;
      /** Seconds until this attempt starts; 0 = it is running. */
      nextRetryInSecs: number;
    }
  | { status: "disconnected"; reason: string | null };

/** `SessionState["status"]`. */
export type SessionStatus = SessionState["status"];

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

// ---------------------------------------------------------------------------
// Drag out (`iris_core::drag_out`)
// ---------------------------------------------------------------------------

/** One drag of remote files out of the window; chosen by the webview. */
export type DragOutId = string;

/** A prepared drag out (`iris_core::DragOutReady`). */
export interface DragOutReady {
  dragId: DragOutId;
  /** Absolute local paths of the selected items, in order. */
  paths: string[];
  /** Files downloaded (folders not counted). */
  files: number;
  totalBytes: number;
}

/** Payload of `dragOut:progress`; the last one has `bytesDone === totalBytes`. */
export interface DragOutProgressEvent {
  type: "dragOutProgress";
  dragId: DragOutId;
  bytesDone: number;
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Sync (`iris_core::sync`)
// ---------------------------------------------------------------------------

/** One folder comparison (UUID string, `iris_core::SyncPlanId`). */
export type SyncPlanId = string;

/** `update`: copy new and changed files; `mirror`: also delete extras. */
export type SyncMode = "update" | "mirror";

/** When a file on both sides is copied (`iris_core::CompareRule`). */
export type CompareRule =
  "sizeOrDate" | "newerOnly" | "sizeOnly" | "everything";

/** What `planSync` compares with (`iris_core::SyncOptions`); all optional. */
export interface SyncOptions {
  mode?: SyncMode;
  rule?: CompareRule;
  /** Keep target files newer than the source (default on). */
  protectNewer?: boolean;
  /** Leave dotfiles and hidden entries alone on both sides (default off). */
  skipHidden?: boolean;
  /** Create source folders that have no files to copy (default on). */
  copyEmptyFolders?: boolean;
  /** Skip source files larger than this many MB; `null` = no limit. */
  maxFileSizeMb?: number | null;
  /** Name patterns to leave alone; omitted = the `syncExcludes` setting. */
  excludes?: string[] | null;
  /**
   * Only compare files changed at or after `sinceUnix` (unix seconds, our
   * clock); `null` = everything. Refused with Mirror (`invalidInput`).
   */
  changedWithin?: ChangedWithin | null;
}

/** The time window of a sync (`iris_core::ChangedWithin`). */
export interface ChangedWithin {
  sinceUnix: number;
}

/** How a windowed plan found its files (`iris_core::SearchMethod`). */
export type SearchMethod = "serverFind" | "walk";

/** What a windowed plan reports (`iris_core::SyncWindow`). */
export interface SyncWindow {
  /** The cutoff asked for (our clock). */
  sinceUnix: number;
  /** `serverFind`: one `find` on the server; `walk`: folders walked. */
  method: SearchMethod;
  /**
   * Seconds the server's clock is ahead of ours (negative: behind), when
   * more than a minute and the cutoff was moved by it; else `null`.
   */
  clockSkewSecs: number | null;
}

/** Where a plan item landed (`iris_core::SyncGroup`). */
export type SyncGroup =
  | "new"
  | "changed"
  | "same"
  | "targetNewer"
  | "differentSizeSameDate"
  | "targetOnly"
  | "typeMismatch"
  | "excluded"
  | "skipped";

/** One path of a plan (`iris_core::SyncItem`). */
export interface SyncItem {
  /** Relative to the synced folders, `/`-separated. */
  path: string;
  kind: "file" | "dir" | "other";
  group: SyncGroup;
  /** The source file's size and date; `null` when no file is there. */
  srcSize: number | null;
  srcMtime: number | null;
  dstSize: number | null;
  dstMtime: number | null;
  /** Why it is skipped, excluded or mismatched. */
  reason: string | null;
  /** Ticked by default. */
  selected: boolean;
}

/** Items and bytes of one group (`iris_core::SyncTotal`). */
export interface SyncTotal {
  files: number;
  dirs: number;
  bytes: number;
}

/** What `planSync` returns (`iris_core::SyncPlan`). */
export interface SyncPlan {
  planId: SyncPlanId;
  sessionId: SessionId;
  /** `upload`: Local → Remote; `download`: Remote → Local. */
  direction: TransferDirection;
  mode: SyncMode;
  localDir: string;
  remoteDir: string;
  /** Path order, folders before their contents; `same` files left out. */
  items: SyncItem[];
  /** Every group, also the empty ones. */
  totals: Record<SyncGroup, SyncTotal>;
  /** For a plan limited to changed files: how they were found. */
  window: SyncWindow | null;
}

/**
 * What a comparison is doing (`iris_core::SyncScanStage`): walking
 * folders, searching the server, or looking up changed files on the target.
 */
export type SyncScanStage = "scanning" | "searching" | "checking";

/**
 * Payload of `sync:progress`: how far a comparison got (at most ten a
 * second, one at each new stage). `scanning`: folders walked and files
 * seen, both sides together (a windowed walk counts changed files only);
 * `searching`: changed files the server search found so far; `checking`:
 * `checked` of `filesSeen` changed files looked up on the target.
 */
export interface SyncProgressEvent {
  type: "syncProgress";
  /** The id `planSync` was given. */
  planId: SyncPlanId;
  stage: SyncScanStage;
  foldersScanned: number;
  filesSeen: number;
  checked: number;
}

/** Payload of `sync:finished`: a run's copies and deletes are done. */
export interface SyncFinishedEvent {
  type: "syncFinished";
  planId: SyncPlanId;
  /** The transfer batch of its copies. */
  batchId: BatchId;
  sessionId: SessionId;
  direction: TransferDirection;
  copied: number;
  skipped: number;
  failed: number;
  cancelled: number;
  deleted: number;
  /** Target-only items not deleted (see `note`). */
  kept: number;
  /** Why something was not deleted, in Iris' words. */
  note: string | null;
}
