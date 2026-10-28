//! Drag-out commands: download a remote selection into the cache so the
//! webview can start a native drag with local files (the drag itself is
//! `tauri-plugin-drag`'s `start_drag`), cancel a preparation, and report
//! how the drag ended. Progress arrives as `dragOut:progress` events.
//!
//! `async` so the core can spawn the delayed cleanup on the Tokio runtime.

use tauri::State;

use iris_core::{DragOutId, DragOutReady, SessionId};

use crate::error::IpcError;
use crate::state::AppState;

/// Download `paths` of the session for a drag out (`dragId` chosen by the
/// webview). Rejects with `tooLarge` over the limits, `cancelled` after
/// `cancel_drag_out`.
#[tauri::command]
pub async fn prepare_drag_out(
    state: State<'_, AppState>,
    drag_id: DragOutId,
    session_id: SessionId,
    paths: Vec<String>,
) -> Result<DragOutReady, IpcError> {
    Ok(state
        .core
        .prepare_drag_out(drag_id, session_id, paths)
        .await?)
}

/// Stop preparing a drag, or throw a prepared one away.
#[tauri::command]
pub async fn cancel_drag_out(
    state: State<'_, AppState>,
    drag_id: DragOutId,
) -> Result<(), IpcError> {
    state.core.cancel_drag_out(drag_id);
    Ok(())
}

/// The native drag ended (`dropped`: something took the files).
#[tauri::command]
pub async fn finish_drag_out(
    state: State<'_, AppState>,
    drag_id: DragOutId,
    dropped: bool,
) -> Result<(), IpcError> {
    state.core.finish_drag_out(drag_id, dropped);
    Ok(())
}
