//! Core domain events and the broadcast bus they travel on.
//!
//! The [`crate::Core`] publishes low-volume lifecycle notifications here; the
//! Tauri shell subscribes once and forwards each one to the webview as a
//! global event (`src-tauri/src/events.rs`). Events only say *what* changed —
//! the UI re-pulls the data through the matching command, so a dropped event
//! never leaves it with stale contents for long.

use serde::Serialize;
use tokio::sync::broadcast;

const EVENT_CHANNEL_CAPACITY: usize = 256;

/// Events emitted by the [`crate::Core`] for UI layers to react to.
///
/// Phase 0 has a single event; later phases (connections, transfers) add
/// their own variants here.
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
    }
}
