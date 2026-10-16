//! Open local files in their application and show them in the file
//! manager. Remote files go through `edit.rs`.

use tauri::State;

use crate::error::IpcError;
use crate::state::AppState;

/// Open the local file `path` with the editor set for its extension, or the
/// OS default (also when `use_default` is true).
#[tauri::command]
pub fn open_local(
    state: State<'_, AppState>,
    path: String,
    use_default: Option<bool>,
) -> Result<(), IpcError> {
    if use_default.unwrap_or(false) {
        Ok(state.core.open_local_default(&path)?)
    } else {
        Ok(state.core.open_local(&path)?)
    }
}

/// Show the local file or folder `path` in Finder / Explorer.
#[tauri::command]
pub fn reveal_local(state: State<'_, AppState>, path: String) -> Result<(), IpcError> {
    Ok(state.core.reveal_local(&path)?)
}
