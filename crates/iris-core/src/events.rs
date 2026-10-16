//! Core domain events and the broadcast bus they travel on.
//!
//! The [`crate::Core`] publishes low-volume lifecycle notifications here; the
//! Tauri shell subscribes once and forwards each one to the webview as a
//! global event (`src-tauri/src/events.rs`). Events only say *what* changed —
//! the UI re-pulls the data through the matching command, so a dropped event
//! never leaves it with stale contents for long.

use serde::Serialize;
use tokio::sync::broadcast;

use crate::edit::RemoteStamp;
use crate::ids::{
    BatchId, DragOutId, EditId, HostKeyRequestId, ProfileId, SessionId, SyncPlanId, TransferId,
};
use crate::transfer::{ConflictSide, TransferDirection, TransferJob};

/// Room for bursts: a folder of small files finishes many jobs a second,
/// each announcing its state changes.
const EVENT_CHANNEL_CAPACITY: usize = 4096;

/// Events emitted by the [`crate::Core`] for UI layers to react to.
///
/// Serialized type-tagged in camelCase, e.g.
/// `{"type":"sessionStateChanged","sessionId":"…","state":"connected",…}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CoreEvent {
    /// The persisted settings changed; the UI re-pulls them via
    /// `get_settings`.
    SettingsChanged,

    /// The saved connection profiles changed; the UI re-pulls them via
    /// `list_profiles`.
    ProfilesChanged,

    /// A connect reached a server whose host key is not in `known_hosts`.
    /// The connect waits until the UI answers with
    /// `answer_host_key(requestId, trust)` (or the prompt times out, which
    /// rejects the key).
    HostKeyPrompt {
        request_id: HostKeyRequestId,
        /// The connect this prompt belongs to.
        session_id: SessionId,
        host: String,
        port: u16,
        /// SSH algorithm name, e.g. `ssh-ed25519`.
        key_type: String,
        /// OpenSSH-style fingerprint, `SHA256:<base64, no padding>`.
        fingerprint_sha256: String,
    },

    /// A session moved through its lifecycle (see [`SessionState`]).
    SessionStateChanged {
        session_id: SessionId,
        profile_id: ProfileId,
        state: SessionState,
    },

    /// The transfer list changed shape (jobs found by a folder walk,
    /// finished jobs cleared); the UI re-pulls it via `list_transfers`.
    /// Coalesced while a batch is being expanded.
    TransfersUpdated,

    /// One job changed state (or its destination, after `keepBoth`).
    TransferJobChanged { job: TransferJob },

    /// A batch is counting what it will copy (before any job exists): the
    /// files, bytes and folders found so far. At most ten per second, and
    /// once more when the count is complete.
    BatchCounting {
        batch_id: BatchId,
        files: u64,
        bytes: u64,
        folders: u64,
    },

    /// A running job copied more bytes. At most ten per second per job.
    TransferProgress {
        job_id: TransferId,
        batch_id: BatchId,
        bytes_done: u64,
        size: u64,
        /// Over the last few seconds.
        bytes_per_sec: u64,
    },

    /// A job's destination exists; the job waits (`needsDecision`) for
    /// `resolve_conflict`. Not raised when the batch already has an
    /// apply-to-all answer.
    TransferConflict {
        batch_id: BatchId,
        job_id: TransferId,
        src: ConflictSide,
        dst: ConflictSide,
    },

    /// A save of a file open for editing reached the server as `path` (the
    /// original, or the edited copy after a `saveCopy` answer).
    EditUploaded {
        edit_id: EditId,
        session_id: SessionId,
        path: String,
    },

    /// A save found the server copy changed since it was opened (or last
    /// uploaded); `remote` is `None` when it was deleted. The edit waits for
    /// `resolve_edit`.
    EditConflict {
        edit_id: EditId,
        session_id: SessionId,
        path: String,
        remote: Option<RemoteStamp>,
        baseline: RemoteStamp,
    },

    /// Uploading a save (or applying a conflict answer) failed; the next
    /// save tries again. `kind` / `message` as an `IpcError` carries them.
    EditFailed {
        edit_id: EditId,
        session_id: SessionId,
        path: String,
        kind: String,
        message: String,
    },

    /// A drag out of the window downloaded more of its files. At most ten
    /// per second, the last one with `bytes_done == total_bytes`.
    DragOutProgress {
        drag_id: DragOutId,
        bytes_done: u64,
        total_bytes: u64,
    },

    /// A sync comparison walked more of the two folders (both sides
    /// counted together). At most ten per second; the plan id is the one
    /// `plan_sync` was given (or will return).
    SyncProgress {
        plan_id: SyncPlanId,
        folders_scanned: u64,
        files_seen: u64,
    },

    /// A sync run ended: its copies (the transfer batch `batch_id`) are all
    /// finished and, in Mirror mode, its deletes are done. `kept` counts
    /// target-only items not deleted (a copy failed or was cancelled, they
    /// changed since the comparison, or deleting failed); `note` says why,
    /// in Iris' words.
    SyncFinished {
        plan_id: SyncPlanId,
        batch_id: BatchId,
        session_id: SessionId,
        direction: TransferDirection,
        copied: usize,
        skipped: usize,
        failed: usize,
        cancelled: usize,
        deleted: usize,
        kept: usize,
        note: Option<String>,
    },
}

/// Lifecycle of one SSH/SFTP session, tagged by `status` on the wire, e.g.
/// `{"status":"reconnecting","attempt":2,"maxAttempts":5,"nextRetryInSecs":2}`.
///
/// ```text
/// connecting ──► connected ──(drop)──► reconnecting ──► connected
///     │              │                      │
///     ╰──────────────┴──► disconnected ◄────╯ (gave up, or a prompt needed)
/// ```
/// A manual reconnect of a `disconnected` session goes through `connecting`
/// again, keeping the session id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionState {
    Connecting,
    Connected,
    /// The connection dropped unexpectedly and Iris is retrying.
    Reconnecting {
        /// 1-based number of the attempt that is waiting or running.
        attempt: u32,
        max_attempts: u32,
        /// Seconds until that attempt starts; 0 while it runs.
        next_retry_in_secs: u64,
    },
    /// `reason` is Iris-owned text, set when the user did not ask for it (a
    /// failed connect, a dropped connection that was not or could not be
    /// re-established); `None` for a user disconnect.
    Disconnected {
        reason: Option<String>,
    },
}

/// Fan-out bus for [`CoreEvent`]s, backed by a tokio broadcast channel.
#[derive(Debug, Clone)]
pub struct EventBus {
    tx: broadcast::Sender<CoreEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self { tx }
    }

    /// Publish an event; silently drops it when there are no subscribers.
    pub fn publish(&self, event: CoreEvent) {
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribers_receive_published_events() {
        let bus = EventBus::new();
        let mut rx = bus.subscribe();
        bus.publish(CoreEvent::SettingsChanged);
        assert_eq!(rx.try_recv().unwrap(), CoreEvent::SettingsChanged);
    }

    #[test]
    fn publishing_without_subscribers_is_a_no_op() {
        EventBus::new().publish(CoreEvent::SettingsChanged);
    }

    #[test]
    fn events_serialize_type_tagged_in_camel_case() {
        let json = serde_json::to_string(&CoreEvent::SettingsChanged).unwrap();
        assert_eq!(json, r#"{"type":"settingsChanged"}"#);
        let json = serde_json::to_string(&CoreEvent::ProfilesChanged).unwrap();
        assert_eq!(json, r#"{"type":"profilesChanged"}"#);
    }

    #[test]
    fn host_key_prompt_fields_are_camel_case() {
        let request_id = HostKeyRequestId::new();
        let session_id = SessionId::new();
        let json = serde_json::to_value(CoreEvent::HostKeyPrompt {
            request_id,
            session_id,
            host: "example.test".into(),
            port: 2222,
            key_type: "ssh-ed25519".into(),
            fingerprint_sha256: "SHA256:abc".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "hostKeyPrompt");
        assert_eq!(json["requestId"], request_id.to_string());
        assert_eq!(json["sessionId"], session_id.to_string());
        assert_eq!(json["keyType"], "ssh-ed25519");
        assert_eq!(json["fingerprintSha256"], "SHA256:abc");
        assert_eq!(json["port"], 2222);
    }

    #[test]
    fn transfer_events_are_camel_case() {
        let json = serde_json::to_value(CoreEvent::TransferProgress {
            job_id: TransferId::new(),
            batch_id: BatchId::new(),
            bytes_done: 10,
            size: 20,
            bytes_per_sec: 5,
        })
        .unwrap();
        assert_eq!(json["type"], "transferProgress");
        assert_eq!(json["bytesDone"], 10);
        assert_eq!(json["bytesPerSec"], 5);
        assert!(json["jobId"].is_string());

        let side = |path: &str| ConflictSide {
            path: path.into(),
            size: 3,
            mtime: Some(1_700_000_000),
        };
        let json = serde_json::to_value(CoreEvent::TransferConflict {
            batch_id: BatchId::new(),
            job_id: TransferId::new(),
            src: side("/local/a.txt"),
            dst: side("/srv/a.txt"),
        })
        .unwrap();
        assert_eq!(json["type"], "transferConflict");
        assert_eq!(json["dst"]["path"], "/srv/a.txt");
        assert_eq!(json["src"]["mtime"], 1_700_000_000);
        assert_eq!(
            serde_json::to_value(CoreEvent::TransfersUpdated).unwrap(),
            serde_json::json!({ "type": "transfersUpdated" })
        );
        let batch_id = BatchId::new();
        assert_eq!(
            serde_json::to_value(CoreEvent::BatchCounting {
                batch_id,
                files: 1234,
                bytes: 56_000_000,
                folders: 7,
            })
            .unwrap(),
            serde_json::json!({
                "type": "batchCounting",
                "batchId": batch_id.to_string(),
                "files": 1234,
                "bytes": 56_000_000,
                "folders": 7,
            })
        );
    }

    #[test]
    fn edit_events_are_camel_case() {
        let stamp = |size| RemoteStamp {
            size,
            mtime: Some(1_700_000_000),
        };
        let json = serde_json::to_value(CoreEvent::EditConflict {
            edit_id: EditId::new(),
            session_id: SessionId::new(),
            path: "/srv/notes.txt".into(),
            remote: None,
            baseline: stamp(4),
        })
        .unwrap();
        assert_eq!(json["type"], "editConflict");
        assert!(json["editId"].is_string());
        assert!(json["remote"].is_null());
        assert_eq!(json["baseline"]["size"], 4);
        let json = serde_json::to_value(CoreEvent::EditFailed {
            edit_id: EditId::new(),
            session_id: SessionId::new(),
            path: "/srv/notes.txt".into(),
            kind: "permissionDenied".into(),
            message: "permission denied: /srv/notes.txt".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "editFailed");
        assert_eq!(json["kind"], "permissionDenied");
        let json = serde_json::to_value(CoreEvent::EditUploaded {
            edit_id: EditId::new(),
            session_id: SessionId::new(),
            path: "/srv/notes.txt".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "editUploaded");
        assert_eq!(json["path"], "/srv/notes.txt");
    }

    #[test]
    fn sync_finished_is_camel_case() {
        let json = serde_json::to_value(CoreEvent::SyncFinished {
            plan_id: SyncPlanId::new(),
            batch_id: BatchId::new(),
            session_id: SessionId::new(),
            direction: TransferDirection::Download,
            copied: 3,
            skipped: 0,
            failed: 1,
            cancelled: 0,
            deleted: 0,
            kept: 2,
            note: Some("a copy failed or was cancelled, so nothing was deleted".into()),
        })
        .unwrap();
        assert_eq!(json["type"], "syncFinished");
        assert!(json["planId"].is_string());
        assert_eq!(json["direction"], "download");
        assert_eq!(json["copied"], 3);
        assert_eq!(json["kept"], 2);
    }

    #[test]
    fn session_state_changed_serializes_state_and_reason() {
        let json = serde_json::to_value(CoreEvent::SessionStateChanged {
            session_id: SessionId::new(),
            profile_id: ProfileId::new(),
            state: SessionState::Disconnected {
                reason: Some("connection lost".into()),
            },
        })
        .unwrap();
        assert_eq!(json["type"], "sessionStateChanged");
        assert_eq!(
            json["state"],
            serde_json::json!({ "status": "disconnected", "reason": "connection lost" })
        );
        assert!(json["profileId"].is_string());
        assert!(json.get("reason").is_none());
    }

    #[test]
    fn session_states_are_tagged_by_status() {
        let json = |s: SessionState| serde_json::to_value(s).unwrap();
        assert_eq!(
            json(SessionState::Connected),
            serde_json::json!({ "status": "connected" })
        );
        assert_eq!(
            json(SessionState::Reconnecting {
                attempt: 2,
                max_attempts: 5,
                next_retry_in_secs: 2,
            }),
            serde_json::json!({
                "status": "reconnecting",
                "attempt": 2,
                "maxAttempts": 5,
                "nextRetryInSecs": 2,
            })
        );
        assert_eq!(
            json(SessionState::Disconnected { reason: None }),
            serde_json::json!({ "status": "disconnected", "reason": null })
        );
    }
}
