//! Core domain events and the broadcast bus they travel on.
//!
//! The [`crate::Core`] publishes low-volume lifecycle notifications here; the
//! Tauri shell subscribes once and forwards each one to the webview as a
//! global event (`src-tauri/src/events.rs`). Events only say *what* changed —
//! the UI re-pulls the data through the matching command, so a dropped event
//! never leaves it with stale contents for long.

use serde::Serialize;
use tokio::sync::broadcast;

use crate::ids::{HostKeyRequestId, ProfileId, SessionId};

const EVENT_CHANNEL_CAPACITY: usize = 256;

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

    /// A session moved through its lifecycle. `reason` is set on a
    /// `disconnected` that was not asked for (failed connect, dropped
    /// connection) and is Iris-owned text.
    SessionStateChanged {
        session_id: SessionId,
        profile_id: ProfileId,
        state: SessionState,
        reason: Option<String>,
    },
}

/// Lifecycle of one SSH/SFTP session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    Connecting,
    Connected,
    Disconnected,
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
    fn session_state_changed_serializes_state_and_reason() {
        let json = serde_json::to_value(CoreEvent::SessionStateChanged {
            session_id: SessionId::new(),
            profile_id: ProfileId::new(),
            state: SessionState::Disconnected,
            reason: Some("connection lost".into()),
        })
        .unwrap();
        assert_eq!(json["type"], "sessionStateChanged");
        assert_eq!(json["state"], "disconnected");
        assert_eq!(json["reason"], "connection lost");
        assert!(json["profileId"].is_string());
    }
}
