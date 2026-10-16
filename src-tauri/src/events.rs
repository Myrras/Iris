//! Forwards iris-core domain events to the webview as global Tauri events.
//!
//! Most are lifecycle notifications that only say *what* changed; the
//! frontend re-pulls the data through the matching command. Transfer
//! progress is the busy one (at most ten events a second per running job).

use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast::error::RecvError;

use iris_core::{Core, CoreEvent};

/// Spawn the long-lived task that re-emits core events to the frontend.
/// Runs for the whole app lifetime (the core never drops its bus).
pub fn spawn_forwarder(app: AppHandle, core: Arc<Core>) {
    let mut rx = core.subscribe_events();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => forward(&app, event),
                Err(RecvError::Lagged(skipped)) => {
                    // A burst (many small transfers finishing at once)
                    // outran the forwarder. Tell the transfer list to
                    // re-pull so it does not keep stale job states.
                    tracing::warn!(skipped, "event bus lagged; dropped UI events");
                    forward(&app, CoreEvent::TransfersUpdated);
                }
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Webview event names, one per core event. Payloads are the core event's
/// own camelCase serialization (including its `type` tag).
fn event_name(event: &CoreEvent) -> &'static str {
    match event {
        CoreEvent::SettingsChanged => "settings:changed",
        CoreEvent::ProfilesChanged => "profiles:changed",
        CoreEvent::HostKeyPrompt { .. } => "session:host-key-prompt",
        CoreEvent::SessionStateChanged { .. } => "session:state-changed",
        CoreEvent::TransfersUpdated => "transfers:updated",
        CoreEvent::TransferJobChanged { .. } => "transfer:job-changed",
        CoreEvent::BatchCounting { .. } => "transfer:batch-counting",
        CoreEvent::TransferProgress { .. } => "transfer:progress",
        CoreEvent::TransferConflict { .. } => "transfer:conflict",
        CoreEvent::EditUploaded { .. } => "edit:uploaded",
        CoreEvent::EditConflict { .. } => "edit:conflict",
        CoreEvent::EditFailed { .. } => "edit:failed",
        CoreEvent::DragOutProgress { .. } => "dragOut:progress",
        CoreEvent::SyncProgress { .. } => "sync:progress",
        CoreEvent::SyncFinished { .. } => "sync:finished",
    }
}

fn forward(app: &AppHandle, event: CoreEvent) {
    let name = event_name(&event);
    let result = match event {
        // Pure "re-pull" signals carry no payload.
        CoreEvent::SettingsChanged | CoreEvent::ProfilesChanged | CoreEvent::TransfersUpdated => {
            app.emit(name, ())
        }
        _ => app.emit(name, &event),
    };
    if let Err(e) = result {
        tracing::warn!("failed to emit event to webview: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iris_core::{
        BatchId, ConflictSide, DragOutId, EditId, HostKeyRequestId, ProfileId, RemoteStamp,
        SessionId, SessionState, SyncPlanId, TransferDirection, TransferId, TransferJob,
        TransferState,
    };

    #[test]
    fn every_core_event_has_a_webview_name() {
        let cases = [
            (CoreEvent::SettingsChanged, "settings:changed"),
            (CoreEvent::ProfilesChanged, "profiles:changed"),
            (
                CoreEvent::HostKeyPrompt {
                    request_id: HostKeyRequestId::new(),
                    session_id: SessionId::new(),
                    host: "sftp.example.test".into(),
                    port: 22,
                    key_type: "ssh-ed25519".into(),
                    fingerprint_sha256: "SHA256:x".into(),
                },
                "session:host-key-prompt",
            ),
            (
                CoreEvent::SessionStateChanged {
                    session_id: SessionId::new(),
                    profile_id: ProfileId::new(),
                    state: SessionState::Reconnecting {
                        attempt: 1,
                        max_attempts: 5,
                        next_retry_in_secs: 1,
                    },
                },
                "session:state-changed",
            ),
            (CoreEvent::TransfersUpdated, "transfers:updated"),
            (
                CoreEvent::TransferJobChanged {
                    job: TransferJob {
                        id: TransferId::new(),
                        batch_id: BatchId::new(),
                        session_id: SessionId::new(),
                        direction: TransferDirection::Upload,
                        src: "/home/demo/a.txt".into(),
                        dst: "/srv/a.txt".into(),
                        size: 1,
                        bytes_done: 0,
                        state: TransferState::Queued,
                        error: None,
                        folder: false,
                        started_at: None,
                        finished_at: None,
                    },
                },
                "transfer:job-changed",
            ),
            (
                CoreEvent::BatchCounting {
                    batch_id: BatchId::new(),
                    files: 3,
                    bytes: 1024,
                    folders: 1,
                },
                "transfer:batch-counting",
            ),
            (
                CoreEvent::TransferProgress {
                    job_id: TransferId::new(),
                    batch_id: BatchId::new(),
                    bytes_done: 1,
                    size: 2,
                    bytes_per_sec: 3,
                },
                "transfer:progress",
            ),
            (
                CoreEvent::TransferConflict {
                    batch_id: BatchId::new(),
                    job_id: TransferId::new(),
                    src: ConflictSide {
                        path: "/home/demo/a.txt".into(),
                        size: 2,
                        mtime: None,
                    },
                    dst: ConflictSide {
                        path: "/srv/a.txt".into(),
                        size: 1,
                        mtime: Some(1_700_000_000),
                    },
                },
                "transfer:conflict",
            ),
            (
                CoreEvent::EditUploaded {
                    edit_id: EditId::new(),
                    session_id: SessionId::new(),
                    path: "/srv/notes.txt".into(),
                },
                "edit:uploaded",
            ),
            (
                CoreEvent::EditConflict {
                    edit_id: EditId::new(),
                    session_id: SessionId::new(),
                    path: "/srv/notes.txt".into(),
                    remote: None,
                    baseline: RemoteStamp {
                        size: 1,
                        mtime: None,
                    },
                },
                "edit:conflict",
            ),
            (
                CoreEvent::EditFailed {
                    edit_id: EditId::new(),
                    session_id: SessionId::new(),
                    path: "/srv/notes.txt".into(),
                    kind: "remote".into(),
                    message: "remote error: write failed".into(),
                },
                "edit:failed",
            ),
            (
                CoreEvent::DragOutProgress {
                    drag_id: DragOutId::new(),
                    bytes_done: 1,
                    total_bytes: 2,
                },
                "dragOut:progress",
            ),
            (
                CoreEvent::SyncProgress {
                    plan_id: SyncPlanId::new(),
                    folders_scanned: 12,
                    files_seen: 340,
                },
                "sync:progress",
            ),
            (
                CoreEvent::SyncFinished {
                    plan_id: SyncPlanId::new(),
                    batch_id: BatchId::new(),
                    session_id: SessionId::new(),
                    direction: TransferDirection::Upload,
                    copied: 1,
                    skipped: 0,
                    failed: 0,
                    cancelled: 0,
                    deleted: 0,
                    kept: 0,
                    note: None,
                },
                "sync:finished",
            ),
        ];
        for (event, name) in cases {
            assert_eq!(event_name(&event), name);
        }
    }
}
