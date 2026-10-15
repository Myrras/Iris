//! The transfer engine: uploads (local → remote) and downloads (remote →
//! local) as a queue of per-file jobs.
//!
//! ## Shape
//! [`TransferManager`] (owned by [`crate::Core`]) keeps every job in one
//! registry behind a mutex; all state transitions happen there, under the
//! lock, and are announced on the event bus. The async work runs in spawned
//! tasks that never hold the lock across an `.await`:
//!
//! - **Expansion** (`expand.rs`): one task per `enqueue` walks the selected
//!   items, creates the destination folders (`mkdir -p`, existing folders
//!   are fine) before the files inside them are queued, and adds one job per
//!   file as it is found. The IPC call returns right away with the batch id.
//! - **Workers** (`worker.rs`): one task per running job. A queued job
//!   starts when one of `parallelTransfers` slots is free — a counting
//!   semaphore whose size is read from the settings at every acquisition, so
//!   a changed setting applies to the next job that starts. Jobs start in
//!   the order they were queued.
//!
//! Each worker copies over its **own SFTP channel** on the session's SSH
//! connection (opened on demand and pooled per session, never shared by two
//! jobs at once), in 256 KiB chunks; the SFTP client keeps several read or
//! write requests in flight.
//!
//! ## Job states
//! ```text
//! queued ──► running ──► done | failed | skipped
//!   ▲   ╲       │ ╲
//!   │    ╲      │  ╲──► needsDecision ──(resolve_conflict)──► queued
//!   │     ╲     ╰──► paused (connection lost) ──(resume_paused)──► queued
//!   │      ╲
//!   ╰───────╲──── any non-final state ──(cancel)──► cancelled
//! ```
//!
//! ## Conflicts
//! Before writing, a job looks at its destination. When something is there
//! it stops in `needsDecision` and publishes [`CoreEvent::TransferConflict`]
//! — unless its batch already has a policy (an earlier answer with
//! `apply_to_all`), which then decides without asking. See
//! [`ConflictResolution`] for what each answer does.
//!
//! ## Partial files and resume
//! Data is written straight to the final path, so a cancelled or
//! interrupted job leaves a partial file. When the connection drops, a
//! running job goes `paused` with its progress kept; [`TransferManager::
//! resume_paused`] continues it by appending from the destination's current
//! size. A later transfer onto a partial file can do the same through the
//! `resume` conflict answer.
//!
//! ## Symlinks
//! A selected item that is a symlink is followed. Inside a folder, a link
//! to a file is copied as the file it points to; a link to a folder is
//! **not** followed (it could loop back on itself) and, like a broken link
//! or a socket/device, becomes a `skipped` job that says why.

mod expand;
pub mod naming;
pub(crate) mod progress;
mod side;
mod worker;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::{CoreError, CoreResult};
use crate::events::{CoreEvent, EventBus};
use crate::fs::{FileMeta, LocalFs, SftpFs};
use crate::ids::{BatchId, SessionId, TransferId};
use crate::session_manager::SessionManager;

use progress::{SpeedMeter, Throttle, PROGRESS_INTERVAL};

const LOCK_POISONED: &str = "transfer registry lock poisoned";

/// Which way a transfer goes. One pane is local and the other remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    /// Local → remote.
    Upload,
    /// Remote → local.
    Download,
}

/// Where a job is in its life (see the module docs for the transitions).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    /// Waiting for a free slot.
    Queued,
    /// Copying (or checking its destination).
    Running,
    /// The destination exists; waiting for `resolve_conflict`.
    NeedsDecision,
    /// The connection dropped; waiting for `resume_paused`.
    Paused,
    Done,
    /// See the job's `error`.
    Failed,
    Cancelled,
    /// Not copied: the conflict answer was `skip`, or Iris does not copy
    /// this kind of entry (the job's `error` then says why).
    Skipped,
}

impl TransferState {
    /// Still has work ahead of it (counts for the close guard).
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Running | Self::NeedsDecision | Self::Paused
        )
    }

    /// Nothing will happen to it any more.
    pub fn is_finished(self) -> bool {
        !self.is_active()
    }
}

/// Why a job failed (or was skipped by Iris): the `CoreError` kind and its
/// app-owned text, as an `IpcError` would carry them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferError {
    pub kind: String,
    pub message: String,
}

impl From<&CoreError> for TransferError {
    fn from(err: &CoreError) -> Self {
        Self {
            kind: err.kind().to_string(),
            message: err.to_string(),
        }
    }
}

/// One file being copied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
    pub id: TransferId,
    pub batch_id: BatchId,
    pub session_id: SessionId,
    pub direction: TransferDirection,
    /// Full source path (local for uploads, remote for downloads).
    pub src: String,
    /// Full destination path. Changes when a conflict is answered with
    /// `keepBoth`.
    pub dst: String,
    /// Source size in bytes, refreshed when the job starts.
    pub size: u64,
    pub bytes_done: u64,
    pub state: TransferState,
    /// Set when `failed`, and when `skipped` by Iris itself.
    pub error: Option<TransferError>,
}

/// The answer to a [`CoreEvent::TransferConflict`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    /// Overwrite the destination.
    Replace,
    /// Leave the destination alone; the job ends `skipped`.
    Skip,
    /// Copy to the first free `name (2).ext`, `name (3).ext`, … next to it.
    KeepBoth,
    /// Treat the destination as a partial copy and append the rest of the
    /// source to it. Only meaningful when the destination is smaller: one of
    /// the same size counts as already copied (`done`, untouched), and a
    /// larger one cannot be the start of the source, so it is replaced.
    Resume,
}

/// One selected file or folder.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferItem {
    /// Full path on the source side.
    pub src: String,
}

/// What `enqueue_transfers` takes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    /// The remote side.
    pub session_id: SessionId,
    pub direction: TransferDirection,
    pub items: Vec<TransferItem>,
    /// The folder on the destination side the items are copied into.
    pub dst_dir: String,
}

/// One side of a conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub path: String,
    pub size: u64,
    /// Unix seconds, when known.
    pub mtime: Option<i64>,
}

/// Totals over the jobs in the list (skipped and cancelled jobs left out
/// of the byte counts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub total_bytes: u64,
    pub done_bytes: u64,
    /// All transfers together, over the last few seconds.
    pub bytes_per_sec: u64,
    /// Running jobs.
    pub active: usize,
    /// Jobs waiting for a slot.
    pub queued: usize,
    /// Jobs waiting for a conflict answer.
    pub needs_decision: usize,
    pub paused: usize,
}

/// What `list_transfers` returns: every job (in the order they were found)
/// and the totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferList {
    pub jobs: Vec<TransferJob>,
    pub summary: TransferSummary,
}

/// The job queue. Cheap to construct; see the module docs.
pub struct TransferManager {
    shared: Arc<Shared>,
}

impl TransferManager {
    pub(crate) fn new(events: EventBus, sessions: SessionManager, parallel: usize) -> Self {
        Self {
            shared: Arc::new(Shared {
                registry: Mutex::new(Registry::default()),
                events,
                sessions,
                local: LocalFs::new(),
                limit: AtomicUsize::new(parallel.max(1)),
                runtime: OnceLock::new(),
            }),
        }
    }

    /// How many jobs may run at once; applies from the next job that starts.
    pub fn set_parallelism(&self, parallel: usize) {
        self.shared.limit.store(parallel.max(1), Ordering::SeqCst);
        self.shared.pump();
    }

    /// Queue `request`'s items. Validates it, then returns the batch id at
    /// once; folders are expanded into per-file jobs in the background.
    /// Must be called within a Tokio runtime (the jobs run on it).
    pub fn enqueue(&self, request: TransferRequest) -> CoreResult<BatchId> {
        if request.items.is_empty() {
            return Err(CoreError::InvalidInput(
                "there is nothing to transfer".into(),
            ));
        }
        if request.dst_dir.trim().is_empty() {
            return Err(CoreError::InvalidInput(
                "the destination folder is missing".into(),
            ));
        }
        if request.items.iter().any(|item| item.src.trim().is_empty()) {
            return Err(CoreError::InvalidInput("a source path is empty".into()));
        }
        let live = self.shared.sessions.get(request.session_id)?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| CoreError::InvalidInput("transfers need an async runtime".into()))?;
        let _ = self.shared.runtime.set(runtime.clone());

        let batch_id = BatchId::new();
        let token = CancellationToken::new();
        self.shared.lock().batches.insert(
            batch_id,
            BatchEntry {
                token: token.clone(),
                policy: None,
                expanding: true,
            },
        );
        runtime.spawn(expand::run(
            Arc::clone(&self.shared),
            batch_id,
            request,
            live.ssh.fs().clone(),
            token,
        ));
        Ok(batch_id)
    }

    /// Cancel one job. A running job stops after its current chunk and
    /// leaves the partial file; a finished one is left as it is.
    /// `NotFound` for an unknown job.
    pub fn cancel(&self, job_id: TransferId) -> CoreResult<()> {
        let mut reg = self.shared.lock();
        let entry = reg
            .jobs
            .get_mut(&job_id)
            .ok_or_else(|| CoreError::NotFound("transfer".into()))?;
        cancel_entry(&self.shared.events, entry);
        Ok(())
    }

    /// Cancel every unfinished job of a batch and stop expanding it.
    /// `NotFound` for an unknown batch.
    pub fn cancel_batch(&self, batch_id: BatchId) -> CoreResult<()> {
        let mut reg = self.shared.lock();
        let batch = reg
            .batches
            .get(&batch_id)
            .ok_or_else(|| CoreError::NotFound("transfer batch".into()))?;
        batch.token.cancel();
        let reg = &mut *reg;
        for id in &reg.order {
            if let Some(entry) = reg.jobs.get_mut(id) {
                if entry.job.batch_id == batch_id {
                    cancel_entry(&self.shared.events, entry);
                }
            }
        }
        Ok(())
    }

    /// Answer a conflict. With `apply_to_all` the answer also decides the
    /// batch's other open conflicts and every later one (without asking
    /// again). `NotFound` for an unknown job, `InvalidInput` when it is not
    /// waiting for a decision.
    pub fn resolve_conflict(
        &self,
        job_id: TransferId,
        resolution: ConflictResolution,
        apply_to_all: bool,
    ) -> CoreResult<()> {
        {
            let mut reg = self.shared.lock();
            let reg = &mut *reg;
            let entry = reg
                .jobs
                .get(&job_id)
                .ok_or_else(|| CoreError::NotFound("transfer".into()))?;
            if entry.job.state != TransferState::NeedsDecision {
                return Err(CoreError::InvalidInput(
                    "the transfer is not waiting for a decision".into(),
                ));
            }
            let batch_id = entry.job.batch_id;
            let mut decided = vec![job_id];
            if apply_to_all {
                if let Some(batch) = reg.batches.get_mut(&batch_id) {
                    batch.policy = Some(resolution);
                }
                decided.extend(reg.order.iter().copied().filter(|id| {
                    *id != job_id
                        && reg.jobs.get(id).is_some_and(|e| {
                            e.job.batch_id == batch_id
                                && e.job.state == TransferState::NeedsDecision
                        })
                }));
            }
            // The answered job goes first, ahead of the rest of the queue:
            // the user is looking at it.
            for id in decided.iter().rev() {
                if let Some(entry) = reg.jobs.get_mut(id) {
                    entry.resolution = Some(resolution);
                    entry.job.state = TransferState::Queued;
                    publish_changed(&self.shared.events, entry);
                    reg.ready.push_front(*id);
                }
            }
        }
        self.shared.pump();
        Ok(())
    }

    /// Resume the jobs that paused when `session_id`'s connection dropped.
    /// Returns how many were queued again.
    pub fn resume_paused(&self, session_id: SessionId) -> usize {
        self.resume_paused_on(session_id, session_id)
    }

    /// Resume the jobs paused on `paused_on` over the session `resume_on`
    /// (a reconnect opens a new session). Returns how many were queued.
    pub fn resume_paused_on(&self, paused_on: SessionId, resume_on: SessionId) -> usize {
        let count = {
            let mut reg = self.shared.lock();
            let reg = &mut *reg;
            let mut count = 0;
            for id in &reg.order {
                let Some(entry) = reg.jobs.get_mut(id) else {
                    continue;
                };
                if entry.job.session_id == paused_on && entry.job.state == TransferState::Paused {
                    entry.job.session_id = resume_on;
                    entry.job.state = TransferState::Queued;
                    entry.job.error = None;
                    publish_changed(&self.shared.events, entry);
                    reg.ready.push_back(*id);
                    count += 1;
                }
            }
            count
        };
        self.shared.pump();
        count
    }

    /// Every job, in the order they were found, with the totals.
    pub fn list(&self) -> TransferList {
        let now = Instant::now();
        let mut reg = self.shared.lock();
        let reg = &mut *reg;
        let jobs: Vec<TransferJob> = reg
            .order
            .iter()
            .filter_map(|id| reg.jobs.get(id).map(|e| e.job.clone()))
            .collect();
        let mut summary = TransferSummary {
            total_bytes: 0,
            done_bytes: 0,
            bytes_per_sec: reg.speed.rate(now),
            active: 0,
            queued: 0,
            needs_decision: 0,
            paused: 0,
        };
        for job in &jobs {
            match job.state {
                TransferState::Running => summary.active += 1,
                TransferState::Queued => summary.queued += 1,
                TransferState::NeedsDecision => summary.needs_decision += 1,
                TransferState::Paused => summary.paused += 1,
                _ => {}
            }
            if !matches!(job.state, TransferState::Skipped | TransferState::Cancelled) {
                summary.total_bytes += job.size;
                summary.done_bytes += job.bytes_done.min(job.size);
            }
        }
        TransferList { jobs, summary }
    }

    /// Drop finished jobs (done, failed, cancelled, skipped) from the list,
    /// and batches with nothing left.
    pub fn clear_finished(&self) {
        {
            let mut reg = self.shared.lock();
            let reg = &mut *reg;
            reg.jobs.retain(|_, e| e.job.state.is_active());
            let jobs = &reg.jobs;
            reg.order.retain(|id| jobs.contains_key(id));
            reg.batches.retain(|batch_id, batch| {
                batch.expanding || jobs.values().any(|e| e.job.batch_id == *batch_id)
            });
        }
        self.shared.events.publish(CoreEvent::TransfersUpdated);
    }

    /// Whether any job is queued, running, waiting for a decision or
    /// paused, or a batch is still being expanded.
    pub fn has_active(&self) -> bool {
        let reg = self.shared.lock();
        reg.batches.values().any(|b| b.expanding)
            || reg.jobs.values().any(|e| e.job.state.is_active())
    }

    /// Drop the pooled SFTP channels of a session that is going away.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        self.shared.forget_pool(session_id);
    }
}

/// Cancel one job: a running one through its token (its worker records
/// the outcome), any other unfinished one right away.
fn cancel_entry(events: &EventBus, entry: &mut JobEntry) {
    match entry.job.state {
        TransferState::Running => entry.token.cancel(),
        state if state.is_active() => {
            entry.token.cancel();
            entry.job.state = TransferState::Cancelled;
            publish_changed(events, entry);
        }
        _ => {}
    }
}

fn publish_changed(events: &EventBus, entry: &JobEntry) {
    events.publish(CoreEvent::TransferJobChanged {
        job: entry.job.clone(),
    });
}

/// What a worker ended with.
pub(crate) enum Outcome {
    Done,
    Skipped,
    Cancelled,
    /// The connection is gone; keep the progress for a resume.
    Paused,
    Failed(CoreError),
    /// The destination exists and nothing decided what to do.
    Conflict {
        src: FileMeta,
        dst: FileMeta,
    },
}

/// A running job's inputs, copied out of the registry.
pub(crate) struct JobContext {
    pub id: TransferId,
    pub batch_id: BatchId,
    pub session_id: SessionId,
    pub direction: TransferDirection,
    pub src: String,
    pub dst_dir: String,
    pub name: String,
    /// The destination is this job's own partial copy: append to it.
    pub append: bool,
    /// The answer to this job's own conflict.
    pub resolution: Option<ConflictResolution>,
    pub token: CancellationToken,
}

struct JobEntry {
    job: TransferJob,
    dst_dir: String,
    name: String,
    token: CancellationToken,
    append: bool,
    resolution: Option<ConflictResolution>,
    throttle: Throttle,
    speed: SpeedMeter,
}

struct BatchEntry {
    token: CancellationToken,
    /// An `apply_to_all` answer.
    policy: Option<ConflictResolution>,
    expanding: bool,
}

#[derive(Default)]
struct Registry {
    jobs: HashMap<TransferId, JobEntry>,
    /// Discovery order.
    order: Vec<TransferId>,
    batches: HashMap<BatchId, BatchEntry>,
    /// Queued jobs, next first.
    ready: VecDeque<TransferId>,
    running: usize,
    /// Idle SFTP channels per session.
    pools: HashMap<SessionId, Vec<SftpFs>>,
    /// All transfers together.
    speed: SpeedMeter,
}

/// A job to add to the registry.
pub(crate) struct NewJob {
    pub batch_id: BatchId,
    pub session_id: SessionId,
    pub direction: TransferDirection,
    pub src: String,
    pub dst_dir: String,
    pub name: String,
    pub dst: String,
    pub size: u64,
    /// `None` queues the job; otherwise it is recorded as already finished
    /// (skipped or failed during expansion).
    pub finished: Option<(TransferState, TransferError)>,
}

/// What the manager and its tasks share.
pub(crate) struct Shared {
    registry: Mutex<Registry>,
    events: EventBus,
    sessions: SessionManager,
    local: LocalFs,
    limit: AtomicUsize,
    /// Where workers are spawned; captured by the first `enqueue`, so a
    /// later settings change from a plain thread can still start jobs.
    runtime: OnceLock<tokio::runtime::Handle>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().expect(LOCK_POISONED)
    }

    pub fn publish(&self, event: CoreEvent) {
        self.events.publish(event);
    }

    /// Record a job found by the expansion and queue it (unless it is
    /// already finished). Returns `false` when its batch was cancelled.
    pub fn add_job(self: &Arc<Self>, new: NewJob) -> bool {
        {
            let mut reg = self.lock();
            let Some(batch) = reg.batches.get(&new.batch_id) else {
                return false;
            };
            if batch.token.is_cancelled() {
                return false;
            }
            let token = batch.token.child_token();
            let id = TransferId::new();
            let (state, error) = match new.finished {
                Some((state, error)) => (state, Some(error)),
                None => (TransferState::Queued, None),
            };
            reg.jobs.insert(
                id,
                JobEntry {
                    job: TransferJob {
                        id,
                        batch_id: new.batch_id,
                        session_id: new.session_id,
                        direction: new.direction,
                        src: new.src,
                        dst: new.dst,
                        size: new.size,
                        bytes_done: 0,
                        state,
                        error,
                    },
                    dst_dir: new.dst_dir,
                    name: new.name,
                    token,
                    append: false,
                    resolution: None,
                    throttle: Throttle::new(PROGRESS_INTERVAL),
                    speed: SpeedMeter::new(),
                },
            );
            reg.order.push(id);
            if state == TransferState::Queued {
                reg.ready.push_back(id);
            }
        }
        self.pump();
        true
    }

    /// The expansion of `batch_id` is over.
    pub fn expansion_done(&self, batch_id: BatchId) {
        if let Some(batch) = self.lock().batches.get_mut(&batch_id) {
            batch.expanding = false;
        }
        self.publish(CoreEvent::TransfersUpdated);
    }

    /// Start queued jobs while slots are free.
    fn pump(self: &Arc<Self>) {
        let Some(runtime) = self.runtime.get() else {
            return;
        };
        let limit = self.limit.load(Ordering::SeqCst);
        let mut reg = self.lock();
        while reg.running < limit {
            let Some(id) = reg.ready.pop_front() else {
                break;
            };
            let Some(entry) = reg.jobs.get_mut(&id) else {
                continue;
            };
            // Cancelled while it waited.
            if entry.job.state != TransferState::Queued {
                continue;
            }
            entry.job.state = TransferState::Running;
            entry.throttle = Throttle::new(PROGRESS_INTERVAL);
            entry.speed = SpeedMeter::new();
            publish_changed(&self.events, entry);
            reg.running += 1;
            runtime.spawn(worker::run(Arc::clone(self), id));
        }
    }

    /// A running job's inputs; `None` when it is gone.
    pub fn context(&self, id: TransferId) -> Option<JobContext> {
        let reg = self.lock();
        let entry = reg.jobs.get(&id)?;
        Some(JobContext {
            id,
            batch_id: entry.job.batch_id,
            session_id: entry.job.session_id,
            direction: entry.job.direction,
            src: entry.job.src.clone(),
            dst_dir: entry.dst_dir.clone(),
            name: entry.name.clone(),
            append: entry.append,
            resolution: entry.resolution,
            token: entry.token.clone(),
        })
    }

    /// Record how a worker ended and start the next job.
    pub fn finish(self: &Arc<Self>, id: TransferId, outcome: Outcome) {
        {
            let mut reg = self.lock();
            let reg = &mut *reg;
            reg.running = reg.running.saturating_sub(1);
            // An `apply_to_all` answer may have arrived while this job was
            // looking at its destination: let it decide right away.
            let policy = reg
                .jobs
                .get(&id)
                .and_then(|e| reg.batches.get(&e.job.batch_id))
                .and_then(|b| b.policy);
            if let Some(entry) = reg.jobs.get_mut(&id) {
                let cancelled = entry.token.is_cancelled();
                match outcome {
                    Outcome::Done => {
                        entry.job.state = TransferState::Done;
                        entry.job.bytes_done = entry.job.size;
                    }
                    Outcome::Skipped => entry.job.state = TransferState::Skipped,
                    _ if cancelled => entry.job.state = TransferState::Cancelled,
                    Outcome::Cancelled => entry.job.state = TransferState::Cancelled,
                    Outcome::Paused => entry.job.state = TransferState::Paused,
                    Outcome::Failed(err) => {
                        entry.job.state = TransferState::Failed;
                        entry.job.error = Some(TransferError::from(&err));
                    }
                    Outcome::Conflict { .. } if policy.is_some() => {
                        entry.resolution = policy;
                        entry.job.state = TransferState::Queued;
                        reg.ready.push_front(id);
                    }
                    Outcome::Conflict { src, dst } => {
                        entry.job.state = TransferState::NeedsDecision;
                        self.events.publish(CoreEvent::TransferConflict {
                            batch_id: entry.job.batch_id,
                            job_id: id,
                            src: ConflictSide {
                                path: entry.job.src.clone(),
                                size: src.size,
                                mtime: src.mtime,
                            },
                            dst: ConflictSide {
                                path: entry.job.dst.clone(),
                                size: dst.size,
                                mtime: dst.mtime,
                            },
                        });
                    }
                }
                publish_changed(&self.events, entry);
            }
        }
        self.pump();
    }

    /// The batch's `apply_to_all` answer, if any.
    pub fn batch_policy(&self, batch_id: BatchId) -> Option<ConflictResolution> {
        self.lock().batches.get(&batch_id).and_then(|b| b.policy)
    }

    /// The source size, as found when the job started.
    pub fn set_size(&self, id: TransferId, size: u64) {
        if let Some(entry) = self.lock().jobs.get_mut(&id) {
            entry.job.size = size;
        }
    }

    /// A `keepBoth` answer picked a new destination name.
    pub fn set_destination(&self, id: TransferId, name: String, dst: String) {
        if let Some(entry) = self.lock().jobs.get_mut(&id) {
            entry.name = name;
            entry.job.dst = dst;
            publish_changed(&self.events, entry);
        }
    }

    /// The destination is opened for writing from `offset`: from now on it
    /// is this job's own (partial) copy, and the conflict answer is spent.
    pub fn start_writing(&self, id: TransferId, offset: u64) {
        if let Some(entry) = self.lock().jobs.get_mut(&id) {
            entry.append = true;
            entry.resolution = None;
            entry.job.bytes_done = offset;
        }
    }

    /// The job is complete without copying (a `resume` onto a full copy).
    pub fn set_bytes_done(&self, id: TransferId, bytes: u64) {
        if let Some(entry) = self.lock().jobs.get_mut(&id) {
            entry.job.bytes_done = bytes;
        }
    }

    /// `delta` more bytes were written; publishes a throttled
    /// [`CoreEvent::TransferProgress`].
    pub fn progress(&self, id: TransferId, delta: u64) {
        let now = Instant::now();
        let mut reg = self.lock();
        let reg = &mut *reg;
        reg.speed.record(now, delta);
        let Some(entry) = reg.jobs.get_mut(&id) else {
            return;
        };
        entry.job.bytes_done += delta;
        entry.speed.record(now, delta);
        if entry.throttle.ready(now) {
            self.events.publish(CoreEvent::TransferProgress {
                job_id: id,
                batch_id: entry.job.batch_id,
                bytes_done: entry.job.bytes_done,
                size: entry.job.size,
                bytes_per_sec: entry.speed.rate(now),
            });
        }
    }

    /// An idle channel of the session, or a new one.
    pub async fn take_channel(&self, session_id: SessionId) -> CoreResult<SftpFs> {
        let pooled = self.lock().pools.get_mut(&session_id).and_then(Vec::pop);
        if let Some(channel) = pooled {
            return Ok(channel);
        }
        let live = self.sessions.get(session_id)?;
        live.ssh.open_sftp_channel().await
    }

    /// Hand a healthy channel back for the next job — unless the session
    /// is gone by now.
    pub fn return_channel(&self, session_id: SessionId, channel: SftpFs) {
        if self.session_alive(session_id) {
            self.lock()
                .pools
                .entry(session_id)
                .or_default()
                .push(channel);
        }
    }

    pub fn forget_pool(&self, session_id: SessionId) {
        self.lock().pools.remove(&session_id);
    }

    /// Whether the session is registered and its connection still up.
    pub fn session_alive(&self, session_id: SessionId) -> bool {
        self.sessions
            .get(session_id)
            .is_ok_and(|live| !live.ssh.is_closed())
    }

    pub fn local(&self) -> LocalFs {
        self.local.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jobs_serialize_camel_case_with_a_flat_state() {
        let job = TransferJob {
            id: TransferId::new(),
            batch_id: BatchId::new(),
            session_id: SessionId::new(),
            direction: TransferDirection::Upload,
            src: "/home/demo/a.txt".into(),
            dst: "/srv/a.txt".into(),
            size: 10,
            bytes_done: 4,
            state: TransferState::NeedsDecision,
            error: None,
        };
        let json = serde_json::to_value(&job).unwrap();
        assert_eq!(json["state"], "needsDecision");
        assert_eq!(json["direction"], "upload");
        assert_eq!(json["bytesDone"], 4);
        assert!(json["batchId"].is_string());
        assert!(json["error"].is_null());

        let failed = TransferJob {
            state: TransferState::Failed,
            error: Some(TransferError::from(&CoreError::NotFound("/a".into()))),
            ..job
        };
        let json = serde_json::to_value(&failed).unwrap();
        assert_eq!(json["error"]["kind"], "notFound");
        assert_eq!(json["error"]["message"], "not found: /a");
    }

    #[test]
    fn requests_and_answers_parse_from_camel_case() {
        let request: TransferRequest = serde_json::from_value(serde_json::json!({
            "sessionId": SessionId::new().to_string(),
            "direction": "download",
            "items": [{ "src": "/srv/a.txt" }],
            "dstDir": "/home/demo",
        }))
        .unwrap();
        assert_eq!(request.direction, TransferDirection::Download);
        assert_eq!(request.items[0].src, "/srv/a.txt");
        let answer: ConflictResolution = serde_json::from_str("\"keepBoth\"").unwrap();
        assert_eq!(answer, ConflictResolution::KeepBoth);
    }

    #[test]
    fn active_states_are_the_unfinished_ones() {
        use TransferState::*;
        for state in [Queued, Running, NeedsDecision, Paused] {
            assert!(state.is_active(), "{state:?}");
        }
        for state in [Done, Failed, Cancelled, Skipped] {
            assert!(state.is_finished(), "{state:?}");
        }
    }
}
