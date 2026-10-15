//! Saved-connection commands: list, create/update and delete profiles
//! (`profiles.json`), their remembered secrets (OS keychain) and the
//! `~/.ssh/config` hosts the form can pick from. Profiles never carry
//! secrets.

use tauri::State;

use iris_core::{ConnectionProfile, ProfileId, Secret, SecretKind, SshConfigHost};

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

/// Delete a profile and its remembered secrets; `notFound` when it does not
/// exist.
#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: ProfileId) -> Result<(), IpcError> {
    Ok(state.core.delete_profile(id)?)
}

/// Remember a password or key passphrase for a saved connection in the OS
/// keychain (`notFound` for an unknown profile, `keychain` when the
/// keychain refuses).
#[tauri::command]
pub fn set_secret(
    state: State<'_, AppState>,
    profile_id: ProfileId,
    kind: SecretKind,
    value: Secret,
) -> Result<(), IpcError> {
    Ok(state.core.set_secret(profile_id, kind, value)?)
}

/// Forget a remembered secret (a no-op when none is stored).
#[tauri::command]
pub fn clear_secret(
    state: State<'_, AppState>,
    profile_id: ProfileId,
    kind: SecretKind,
) -> Result<(), IpcError> {
    Ok(state.core.clear_secret(profile_id, kind)?)
}

/// The concrete `Host` aliases of `~/.ssh/config`, resolved, in file order
/// (empty when there is no config file).
#[tauri::command]
pub fn list_ssh_config_hosts(state: State<'_, AppState>) -> Result<Vec<SshConfigHost>, IpcError> {
    Ok(state.core.list_ssh_config_hosts()?)
}
