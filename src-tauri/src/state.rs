//! Application state shared across all IPC commands.
//!
//! One [`Core`] lives for the lifetime of the app, behind an [`AppState`] handed
//! to Tauri via `.manage(...)` and pulled into commands as
//! `State<'_, AppState>`. The `Arc` lets detached tasks (the event forwarder)
//! hold the core without borrowing Tauri state.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use iris_core::Core;

/// Live application state: the iris-core entry point plus shell-only flags.
pub struct AppState {
    pub core: Arc<Core>,
    /// Set once the user confirms closing despite active work, so the
    /// close/exit guard lets the next attempt through instead of showing the
    /// warning again (see `commands::window` and `lib.rs`).
    pub force_close: AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            core: Arc::new(Core::new()),
            force_close: AtomicBool::new(false),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
