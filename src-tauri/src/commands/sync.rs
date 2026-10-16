//! Folder sync commands: compare the two panes' folders, run a comparison,
//! or throw one away. The end of a run arrives as `sync:finished`; its
//! copies report like any transfer (`transfer:*`).

use tauri::State;

use iris_core::{BatchId, SessionId, SyncOptions, SyncPlan, SyncPlanId, TransferDirection};

use crate::error::IpcError;
use crate::state::AppState;

/// Walk and compare `local_dir` and `remote_dir` for a sync in
/// `direction`; resolves with the plan (kept for `run_sync`).
#[tauri::command]
pub async fn plan_sync(
    state: State<'_, AppState>,
    session_id: SessionId,
    direction: TransferDirection,
    local_dir: String,
    remote_dir: String,
    options: Option<SyncOptions>,
) -> Result<SyncPlan, IpcError> {
    Ok(state
        .core
        .plan_sync(
            session_id,
            direction,
            &local_dir,
            &remote_dir,
            options.unwrap_or_default(),
        )
        .await?)
}

/// Run a plan with the ticked item paths (`None`: its defaults); resolves
/// with the transfer batch of its copies.
#[tauri::command]
pub async fn run_sync(
    state: State<'_, AppState>,
    plan_id: SyncPlanId,
    ticked: Option<Vec<String>>,
) -> Result<BatchId, IpcError> {
    Ok(state.core.run_sync(plan_id, ticked).await?)
}

/// Forget a plan that will not run.
#[tauri::command]
pub async fn discard_sync_plan(
    state: State<'_, AppState>,
    plan_id: SyncPlanId,
) -> Result<(), IpcError> {
    state.core.discard_sync_plan(plan_id);
    Ok(())
}
