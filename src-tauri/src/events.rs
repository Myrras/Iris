//! Forwards iris-core domain events to the webview as global Tauri events.
//!
//! These are low-volume lifecycle notifications that only say *what* changed;
//! the frontend re-pulls the data through the matching command.

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
                    // Lifecycle events are tiny and rare; lagging here means
                    // something is very wrong. The UI can resync by re-pulling.
                    tracing::warn!(skipped, "event bus lagged; dropped UI events");
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
    }
}

fn forward(app: &AppHandle, event: CoreEvent) {
    let name = event_name(&event);
    let result = match event {
        // Pure "re-pull" signals carry no payload.
        CoreEvent::SettingsChanged | CoreEvent::ProfilesChanged => app.emit(name, ()),
        _ => app.emit(name, &event),
    };
    if let Err(e) = result {
        tracing::warn!("failed to emit event to webview: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iris_core::{HostKeyRequestId, ProfileId, SessionId, SessionState};

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
                    state: SessionState::Connected,
                    reason: None,
                },
                "session:state-changed",
            ),
        ];
        for (event, name) in cases {
            assert_eq!(event_name(&event), name);
        }
    }
}
