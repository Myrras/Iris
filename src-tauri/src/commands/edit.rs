//! Remote edit commands: open a remote file in a local editor, answer a
//! conflict, list and close edits. Saves are uploaded by the core on its
//! own and reported as events (`edit:*`, see `events.rs`).
//!
//! `async` so the core can spawn the watcher tasks on the Tokio runtime.

use tauri::State;

use iris_core::{EditId, EditInfo, EditResolution, SessionId};

use crate::error::IpcError;
use crate::state::AppState;

/// Download `path` and open it in the editor set for its extension (or the
/// OS default); resolves with the edit id. A file already open is shown
/// again.
#[tauri::command]
pub async fn open_remote(
    state: State<'_, AppState>,
    session_id: SessionId,
    path: String,
) -> Result<EditId, IpcError> {
    Ok(state.core.open_remote(session_id, &path).await?)
}

/// Answer an `edit:conflict`.
#[tauri::command]
pub async fn resolve_edit(
    state: State<'_, AppState>,
    edit_id: EditId,
    resolution: EditResolution,
) -> Result<(), IpcError> {
    Ok(state.core.resolve_edit(edit_id, resolution)?)
}

/// Every file open for editing.
#[tauri::command]
pub async fn list_edits(state: State<'_, AppState>) -> Result<Vec<EditInfo>, IpcError> {
    Ok(state.core.list_edits())
}

/// Stop editing a file and delete its local copy.
#[tauri::command]
pub async fn close_edit(state: State<'_, AppState>, edit_id: EditId) -> Result<(), IpcError> {
    Ok(state.core.close_edit(edit_id).await?)
}
