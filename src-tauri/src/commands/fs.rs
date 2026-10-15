//! Browsing commands against either side: `target` is
//! `{ kind: "local" }` or `{ kind: "remote", sessionId }`.

use tauri::State;

use iris_core::{Entry, FsTarget};

use crate::error::IpcError;
use crate::state::AppState;

/// The entries of a folder (unsorted; the UI sorts and filters).
#[tauri::command]
pub async fn list_dir(
    state: State<'_, AppState>,
    target: FsTarget,
    path: String,
) -> Result<Vec<Entry>, IpcError> {
    Ok(state.core.list_dir(target, &path).await?)
}

/// One entry; a final symlink is reported, not followed.
#[tauri::command]
pub async fn stat(
    state: State<'_, AppState>,
    target: FsTarget,
    path: String,
) -> Result<Entry, IpcError> {
    Ok(state.core.stat(target, &path).await?)
}

/// The raw target text of a symlink.
#[tauri::command]
pub async fn read_link(
    state: State<'_, AppState>,
    target: FsTarget,
    path: String,
) -> Result<String, IpcError> {
    Ok(state.core.read_link(target, &path).await?)
}

/// The home folder (local) or login folder (remote), absolute.
#[tauri::command]
pub async fn home_dir(state: State<'_, AppState>, target: FsTarget) -> Result<String, IpcError> {
    Ok(state.core.home_dir(target).await?)
}
