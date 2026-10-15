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

fn forward(app: &AppHandle, event: CoreEvent) {
    let result = match event {
        CoreEvent::SettingsChanged => app.emit("settings:changed", ()),
    };
    if let Err(e) = result {
        tracing::warn!("failed to emit event to webview: {e}");
    }
}
