//! Settings commands: read and replace the persisted `settings.json`.

use tauri::State;

use iris_core::IrisSettings;

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
