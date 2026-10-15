//! Transfer commands: queue uploads/downloads, answer conflicts, cancel,
//! and read the job list. Progress and state changes arrive as events
//! (`transfer:*`, see `events.rs`).
//!
//! The commands are `async` so they run on the Tokio runtime, where the
//! core spawns its transfer tasks.

use tauri::State;

use iris_core::{BatchId, ConflictResolution, TransferId, TransferList, TransferRequest};

use crate::error::IpcError;
use crate::state::AppState;

/// Queue the request's items; resolves with the batch id right away
/// (folders are expanded in the background).
#[tauri::command]
pub async fn enqueue_transfers(
    state: State<'_, AppState>,
    request: TransferRequest,
) -> Result<BatchId, IpcError> {
    Ok(state.core.enqueue_transfers(request)?)
}

/// Cancel one job (a running one leaves its partial file).
#[tauri::command]
pub async fn cancel_transfer(
    state: State<'_, AppState>,
    job_id: TransferId,
) -> Result<(), IpcError> {
    Ok(state.core.cancel_transfer(job_id)?)
}

/// Queue a failed job again (a file starts over; an unlisted folder is
/// listed again).
#[tauri::command]
pub async fn retry_transfer(
    state: State<'_, AppState>,
    job_id: TransferId,
) -> Result<(), IpcError> {
    Ok(state.core.retry_transfer(job_id)?)
}

/// Cancel every unfinished job of a batch.
#[tauri::command]
pub async fn cancel_batch(state: State<'_, AppState>, batch_id: BatchId) -> Result<(), IpcError> {
    Ok(state.core.cancel_batch(batch_id)?)
}

/// Answer a `transfer:conflict`; `apply_to_all` decides the rest of the
/// batch's conflicts the same way.
#[tauri::command]
pub async fn resolve_conflict(
    state: State<'_, AppState>,
    job_id: TransferId,
    resolution: ConflictResolution,
    apply_to_all: Option<bool>,
) -> Result<(), IpcError> {
    Ok(state
        .core
        .resolve_conflict(job_id, resolution, apply_to_all.unwrap_or(false))?)
}

/// Every job and the totals.
#[tauri::command]
pub async fn list_transfers(state: State<'_, AppState>) -> Result<TransferList, IpcError> {
    Ok(state.core.list_transfers())
}

/// Drop finished jobs from the list (emits `transfers:updated`).
#[tauri::command]
pub async fn clear_finished(state: State<'_, AppState>) -> Result<(), IpcError> {
    state.core.clear_finished_transfers();
    Ok(())
}

/// Whether any transfer is queued, running, waiting for an answer or
/// paused.
#[tauri::command]
pub async fn has_active_transfers(state: State<'_, AppState>) -> Result<bool, IpcError> {
    Ok(state.core.has_active_transfers())
}
