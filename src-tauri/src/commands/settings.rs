//! Settings commands: read and replace the persisted `settings.json`, and
//! its Local favorite folders.

use tauri::State;

use iris_core::{Favorite, IrisSettings};

use crate::error::IpcError;
use crate::state::AppState;

/// The current settings.
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> IrisSettings {
    state.core.settings()
}

/// Replace the settings; returns what was stored (normalized by the core), or
/// an `invalidInput` error for out-of-range values.
#[tauri::command]
pub fn save_settings(
    state: State<'_, AppState>,
    settings: IrisSettings,
) -> Result<IrisSettings, IpcError> {
    Ok(state.core.save_settings(settings)?)
}

/// Replace the Local favorite folders; returns what was stored, or an
/// `invalidInput` error (relative path, a folder twice, a label over 255
/// characters, more than 200). `save_settings` never changes them.
#[tauri::command]
pub fn set_local_favorites(
    state: State<'_, AppState>,
    favorites: Vec<Favorite>,
) -> Result<Vec<Favorite>, IpcError> {
    Ok(state.core.set_local_favorites(favorites)?)
}
