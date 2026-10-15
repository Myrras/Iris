//! Session commands: connect a saved profile, disconnect, and answer the
//! host key prompt a connect may raise.

use tauri::State;

use iris_core::{Credentials, HostKeyRequestId, ProfileId, Secret, SessionId};

use crate::error::IpcError;
use crate::state::AppState;

/// Connect a saved profile. A `password` / `passphrase` left out is read
/// from the keychain when the login needs it; with `remember`, the given
/// ones are stored there after a successful login (otherwise they are used
/// once). Resolves with the new session id once SFTP is ready; an unknown
/// host key first raises `session:host-key-prompt` and waits for
/// `answer_host_key`.
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    profile_id: ProfileId,
    password: Option<Secret>,
    passphrase: Option<Secret>,
    remember: Option<bool>,
) -> Result<SessionId, IpcError> {
    let credentials = Credentials {
        password,
        passphrase,
        remember: remember.unwrap_or(false),
    };
    Ok(state.core.connect_with(profile_id, credentials).await?)
}

/// Close a session (a no-op when it is already gone).
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: SessionId) -> Result<(), IpcError> {
    Ok(state.core.disconnect(session_id).await?)
}

/// Answer an open host key prompt: `trust` records the key and continues
/// the connect, otherwise the connect fails with `hostKeyRejected`.
#[tauri::command]
pub fn answer_host_key(
    state: State<'_, AppState>,
    request_id: HostKeyRequestId,
    trust: bool,
) -> Result<(), IpcError> {
    Ok(state.core.answer_host_key(request_id, trust)?)
}
