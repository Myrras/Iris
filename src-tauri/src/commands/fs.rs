//! Browsing and file-operation commands against either side: `target` is
//! `{ kind: "local" }` or `{ kind: "remote", sessionId }`.

use tauri::State;

use iris_core::{BatchReport, Entry, FsTarget, Preview};

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

/// Create a folder; rejects with `alreadyExists` when the name is taken.
#[tauri::command]
pub async fn mkdir(
    state: State<'_, AppState>,
    target: FsTarget,
    path: String,
) -> Result<(), IpcError> {
    Ok(state.core.mkdir(target, &path).await?)
}

/// Rename `from` to `to` (full paths); never overwrites (`alreadyExists`).
#[tauri::command]
pub async fn rename(
    state: State<'_, AppState>,
    target: FsTarget,
    from: String,
    to: String,
) -> Result<(), IpcError> {
    Ok(state.core.rename(target, &from, &to).await?)
}

/// Delete each path (local: to the Trash; remote: permanently), reporting
/// per-path failures.
#[tauri::command]
pub async fn delete(
    state: State<'_, AppState>,
    target: FsTarget,
    paths: Vec<String>,
) -> Result<BatchReport, IpcError> {
    Ok(state.core.delete(target, &paths).await?)
}

/// Set the permission bits of each path, optionally recursively.
#[tauri::command]
pub async fn chmod(
    state: State<'_, AppState>,
    target: FsTarget,
    paths: Vec<String>,
    mode: u32,
    recursive: Option<bool>,
) -> Result<BatchReport, IpcError> {
    Ok(state
        .core
        .chmod(target, &paths, mode, recursive.unwrap_or(false))
        .await?)
}

/// A preview of the file at `path`, reading at most `max_bytes`.
#[tauri::command]
pub async fn preview(
    state: State<'_, AppState>,
    target: FsTarget,
    path: String,
    max_bytes: u64,
) -> Result<Preview, IpcError> {
    Ok(state.core.preview(target, &path, max_bytes).await?)
}
