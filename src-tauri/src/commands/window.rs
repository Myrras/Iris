//! Window lifecycle commands.
//!
//! The close/exit guard (see `lib.rs`) prevents the app from quitting while
//! the core reports active work and asks the webview to confirm. When the user
//! confirms, the frontend calls [`window_confirm_close`], which cancels the
//! transfers, sets the force-close flag so the guard steps aside, then exits
//! the app.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};

use crate::state::AppState;

/// Confirm closing despite active work: cancel every transfer (partial
/// files stay where they are), arm the force-close flag and exit the app.
#[tauri::command]
pub fn window_confirm_close(app: AppHandle, state: State<'_, AppState>) {
    state.core.cancel_all_transfers();
    state.force_close.store(true, Ordering::SeqCst);
    app.exit(0);
}
