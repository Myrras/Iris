//! Saved-connection commands: list, create/update and delete profiles
//! (`profiles.json`). Profiles never carry secrets.

use tauri::State;

use iris_core::{ConnectionProfile, ProfileId};

use crate::error::IpcError;
use crate::state::AppState;

/// All saved connections, in creation order.
#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Vec<ConnectionProfile> {
    state.core.list_profiles()
}

/// Create (no or unknown `id`) or replace (known `id`) a profile; returns
/// what was stored, or an `invalidInput` error.
#[tauri::command]
pub fn save_profile(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> Result<ConnectionProfile, IpcError> {
    Ok(state.core.save_profile(profile)?)
}

/// Delete a profile; `notFound` when it does not exist.
#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: ProfileId) -> Result<(), IpcError> {
    Ok(state.core.delete_profile(id)?)
}
