//! One-way folder sync between the Local and the Remote pane's folders.
//!
//! ## Flow
//! 1. [`Core::plan_sync`] walks both folders (recursively, by the transfer
//!    engine's rules; see `walk.rs`), compares them with the pure
//!    [`diff::diff`] and keeps the result as a [`SyncPlan`] for
//!    [`PLAN_TTL`]. The plan lists every item that would be copied or
//!    deleted, and what is skipped and why; identical files are only
//!    counted.
//! 2. [`Core::run_sync`] runs a plan once, with the items the user left
//!    ticked: it creates the destination folders first, then queues every
//!    copy as **one transfer batch** (progress, cancel and retry as for any
//!    transfer). Files found changed are overwritten without a conflict
//!    prompt (`replace` preset); a "new" file that appeared at the
//!    destination meanwhile still asks.
//! 3. In **Mirror** mode the target-only items are deleted **after** every
//!    copy finished: not at all when a copy failed or was cancelled, and
//!    each one only after checking it is still what the plan saw (a file
//!    with the same size and date, a folder with the same contents) —
//!    deepest first, through the normal delete path (local: the Trash;
//!    remote: permanently). [`CoreEvent::SyncFinished`] reports the end.
//!
//! Plans expire after [`PLAN_TTL`] and are dropped when their session is
//! disconnected or its connection is lost: the folders may have changed.
//!
//! ## Choices
//! - Modification times within [`diff::MTIME_TOLERANCE_SECS`] are equal.
//! - A file on one side and a folder on the other (`typeMismatch`) is
//!   reported and left alone, in either mode.
//! - Excluded names ([`exclude`], the `syncExcludes` setting) and, on
//!   request, hidden entries are never copied or deleted.

pub(crate) mod diff;
pub mod exclude;
mod walk;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;

use crate::error::{CoreError, CoreResult};
use crate::events::CoreEvent;
use crate::fs::{is_dotfile, FsTarget};
use crate::ids::{BatchId, SessionId, SyncPlanId};
use crate::settings::normalize_excludes;
use crate::transfer::side::Side;
use crate::transfer::{BatchOutcome, ConflictResolution, TransferDirection, Work};
use crate::Core;

use diff::{DiffRules, Listed, Node};
use walk::{is_connection, walk};

pub use diff::MTIME_TOLERANCE_SECS;

const LOCK_POISONED: &str = "sync plan lock poisoned";

/// How long a plan can be run after it was made.
pub const PLAN_TTL: Duration = Duration::from_secs(10 * 60);

/// The largest "skip files larger than" value, in MB (1 TB).
pub const MAX_FILE_SIZE_MB_LIMIT: u64 = 1024 * 1024;

/// Whether a sync only adds and updates, or also deletes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncMode {
    /// Copy new and changed files; never delete.
    #[default]
    Update,
    /// Also delete what exists only on the target (after a confirm in the
    /// UI, and only once every copy succeeded).
    Mirror,
}

/// When a file that exists on both sides is copied.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompareRule {
    /// The size differs, or the date differs beyond the tolerance.
    #[default]
    SizeOrDate,
    /// Only when the source is newer (beyond the tolerance). Same date and
    /// another size is `differentSizeSameDate`, unticked.
    NewerOnly,
    /// Only when the size differs (for servers that do not keep dates).
    SizeOnly,
    /// Every file, even ones that look the same.
    Everything,
}

/// What `plan_sync` is asked to compare with. Every field has a default, so
/// `{}` is a plain Update with the saved excludes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncOptions {
    pub mode: SyncMode,
    pub rule: CompareRule,
    /// Do not overwrite a target file newer than the source (beyond the
    /// tolerance): it becomes `targetNewer`, unticked. Applies to every rule
    /// but `newerOnly`, where it is implied.
    pub protect_newer: bool,
    /// Ignore dotfiles (and OS-hidden entries) on both sides: never copied,
    /// never deleted.
    pub skip_hidden: bool,
    /// Create source folders that have no files to copy.
    pub copy_empty_folders: bool,
    /// Skip source files larger than this many MB (`None`: no limit).
    pub max_file_size_mb: Option<u64>,
    /// Name patterns to leave alone; `None` uses the `syncExcludes`
    /// setting.
    pub excludes: Option<Vec<String>>,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            mode: SyncMode::Update,
            rule: CompareRule::SizeOrDate,
            protect_newer: true,
            skip_hidden: false,
            copy_empty_folders: true,
            max_file_size_mb: None,
            excludes: None,
        }
    }
}

/// Where an item of a plan landed (see [`diff`] for the rules).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncGroup {
    /// Only on the source: copied.
    New,
    /// On both, different by the rule: overwritten.
    Changed,
    /// On both, alike by the rule: counted, not listed.
    Same,
    /// The target is newer: listed unticked.
    TargetNewer,
    /// Same date, other size (`newerOnly`): listed unticked.
    DifferentSizeSameDate,
    /// Only on the target: deleted in Mirror, kept in Update.
    TargetOnly,
    /// A file on one side, a folder on the other: left alone.
    TypeMismatch,
    /// An exclude pattern, or hidden with "skip hidden".
    Excluded,
    /// Unsupported (links to folders, broken links, devices, unsafe names)
    /// or over the size cap; `reason` says which.
    Skipped,
}

impl SyncGroup {
    pub const ALL: [SyncGroup; 9] = [
        Self::New,
        Self::Changed,
        Self::Same,
        Self::TargetNewer,
        Self::DifferentSizeSameDate,
        Self::TargetOnly,
        Self::TypeMismatch,
        Self::Excluded,
        Self::Skipped,
    ];

    /// Ticked, its items are copied.
    fn copies(self) -> bool {
        matches!(
            self,
            Self::New | Self::Changed | Self::TargetNewer | Self::DifferentSizeSameDate
        )
    }
}

/// What an item is (the source's kind when both sides have it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncItemKind {
    File,
    Dir,
    /// A link or special file a sync does not copy.
    Other,
}

/// One path of a plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    /// Relative to the synced folders, `/`-separated.
    pub path: String,
    pub kind: SyncItemKind,
    pub group: SyncGroup,
    /// The source file's size and date (`None` when it is no file there).
    pub src_size: Option<u64>,
    pub src_mtime: Option<i64>,
    pub dst_size: Option<u64>,
    pub dst_mtime: Option<i64>,
    /// Why it is skipped, excluded or mismatched.
    pub reason: Option<String>,
    /// Ticked by default.
    pub selected: bool,
    #[serde(skip)]
    pub(crate) segments: Vec<String>,
    /// A target-only folder nothing blocked is in: deletable in one go.
    #[serde(skip)]
    pub(crate) whole: bool,
}

impl SyncItem {
    pub(crate) fn new(segments: &[String], src: Option<&Listed>, dst: Option<&Listed>) -> Self {
        let kind = match src.or(dst).map(|e| &e.node) {
            Some(Node::Dir) => SyncItemKind::Dir,
            Some(Node::File { .. }) => SyncItemKind::File,
            _ => SyncItemKind::Other,
        };
        let file = |side: Option<&Listed>| match side.map(|e| &e.node) {
            Some(Node::File { size, mtime }) => (Some(*size), *mtime),
            _ => (None, None),
        };
        let (src_size, src_mtime) = file(src);
        let (dst_size, dst_mtime) = file(dst);
        Self {
            path: segments.join("/"),
            kind,
            group: SyncGroup::Same,
            src_size,
            src_mtime,
            dst_size,
            dst_mtime,
            reason: None,
            selected: false,
            segments: segments.to_vec(),
            whole: false,
        }
    }
}

/// How many items of a group, and their bytes (the source's, or the
/// target's for target-only items).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTotal {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
}

/// A [`SyncTotal`] for every [`SyncGroup`]; on the wire an object keyed by
/// group (`{"new": {"files": 2, …}, …}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SyncTotals(BTreeMap<SyncGroup, SyncTotal>);

impl Default for SyncTotals {
    fn default() -> Self {
        Self(
            SyncGroup::ALL
                .iter()
                .map(|g| (*g, SyncTotal::default()))
                .collect(),
        )
    }
}

impl SyncTotals {
    pub fn get(&self, group: SyncGroup) -> SyncTotal {
        self.0.get(&group).copied().unwrap_or_default()
    }

    pub(crate) fn add(&mut self, item: &SyncItem) {
        let total = self.0.entry(item.group).or_default();
        match item.kind {
            SyncItemKind::Dir => total.dirs += 1,
            _ => total.files += 1,
        }
        let bytes = match item.group {
            SyncGroup::TargetOnly => item.dst_size,
            _ => item.src_size.or(item.dst_size),
        };
        total.bytes += bytes.unwrap_or(0);
    }
}

/// What `plan_sync` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    pub plan_id: SyncPlanId,
    pub session_id: SessionId,
    /// `upload`: Local → Remote; `download`: Remote → Local.
    pub direction: TransferDirection,
    pub mode: SyncMode,
    pub local_dir: String,
    pub remote_dir: String,
    /// In path order, folders before their contents; `same` files left out.
    pub items: Vec<SyncItem>,
    pub totals: SyncTotals,
}

/// A plan kept for `run_sync`.
struct StoredPlan {
    plan: SyncPlan,
    created: Instant,
    copy_empty_folders: bool,
    /// The target as the plan saw it, to check before deleting.
    target: HashMap<Vec<String>, Node>,
}

/// The plans waiting to run. Owned by [`Core`].
pub(crate) struct SyncManager {
    plans: Mutex<HashMap<SyncPlanId, StoredPlan>>,
    ttl: Mutex<Duration>,
    /// Syncs deleting their target-only items right now.
    deleting: AtomicUsize,
}

impl Default for SyncManager {
    fn default() -> Self {
        Self {
            plans: Mutex::default(),
            ttl: Mutex::new(PLAN_TTL),
            deleting: AtomicUsize::new(0),
        }
    }
}

impl SyncManager {
    fn ttl(&self) -> Duration {
        *self.ttl.lock().expect(LOCK_POISONED)
    }

    /// Drop the plans of a session that went away (or whose connection
    /// dropped: what it compared may have changed since).
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        self.plans
            .lock()
            .expect(LOCK_POISONED)
            .retain(|_, p| p.plan.session_id != session_id);
    }

    /// Whether a sync is deleting its target-only items.
    pub(crate) fn is_deleting(&self) -> bool {
        self.deleting.load(Ordering::SeqCst) > 0
    }
}

/// What a run does, worked out from a plan and the ticked items.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Actions {
    /// Files to copy, with the conflict answer they start with.
    pub copies: Vec<(Vec<String>, Option<ConflictResolution>)>,
    /// Destination folders to create (deepest only: parents come along).
    pub mkdirs: Vec<Vec<String>>,
    /// Target-only items to delete, deepest first.
    pub deletes: Vec<Delete>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Delete {
    File(Vec<String>),
    /// A folder and everything in it, if it is unchanged.
    Tree(Vec<String>),
    /// A folder whose contents are not all deleted: removed only when it
    /// is empty by then.
    IfEmpty(Vec<String>),
}

impl Delete {
    fn segments(&self) -> &[String] {
        match self {
            Self::File(s) | Self::Tree(s) | Self::IfEmpty(s) => s,
        }
    }
}

/// Turn `items` into actions; `ticked` holds the paths the user left
/// ticked (`None`: each item's default).
pub(crate) fn actions(
    items: &[SyncItem],
    ticked: Option<&HashSet<String>>,
    mode: SyncMode,
    copy_empty_folders: bool,
) -> Actions {
    let is_ticked = |item: &SyncItem| match ticked {
        Some(set) => set.contains(&item.path),
        None => item.selected,
    };
    let mut out = Actions::default();
    let mut dirs: BTreeSet<Vec<String>> = BTreeSet::new();
    for item in items.iter().filter(|i| i.group.copies() && is_ticked(i)) {
        match item.kind {
            SyncItemKind::File => {
                let resolution = match item.group {
                    // A new file that turned up meanwhile is a real
                    // conflict: ask.
                    SyncGroup::New => None,
                    _ => Some(ConflictResolution::Replace),
                };
                if item.segments.len() > 1 {
                    dirs.insert(item.segments[..item.segments.len() - 1].to_vec());
                }
                out.copies.push((item.segments.clone(), resolution));
            }
            SyncItemKind::Dir if copy_empty_folders => {
                dirs.insert(item.segments.clone());
            }
            _ => {}
        }
    }
    // `mkdir -p` of the deepest folders makes their parents too.
    out.mkdirs = dirs
        .iter()
        .filter(|d| {
            !dirs
                .iter()
                .any(|other| other.len() > d.len() && other.starts_with(d))
        })
        .cloned()
        .collect();

    if mode == SyncMode::Mirror {
        let target_only: Vec<&SyncItem> = items
            .iter()
            .filter(|i| i.group == SyncGroup::TargetOnly)
            .collect();
        let mut roots: Vec<Vec<String>> = Vec::new();
        for item in target_only.iter().filter(|i| is_ticked(i)) {
            if roots
                .iter()
                .any(|r| item.segments.len() > r.len() && item.segments.starts_with(r))
            {
                continue; // Goes with a folder deleted as a whole.
            }
            match item.kind {
                SyncItemKind::Dir => {
                    let all_ticked = target_only.iter().all(|i| {
                        !(i.segments.len() > item.segments.len()
                            && i.segments.starts_with(&item.segments))
                            || is_ticked(i)
                    });
                    if item.whole && all_ticked {
                        roots.push(item.segments.clone());
                        out.deletes.push(Delete::Tree(item.segments.clone()));
                    } else {
                        out.deletes.push(Delete::IfEmpty(item.segments.clone()));
                    }
                }
                _ => out.deletes.push(Delete::File(item.segments.clone())),
            }
        }
        // Deepest first, so a folder comes after what was inside it.
        out.deletes
            .sort_by_key(|d| std::cmp::Reverse(d.segments().len()));
    }
    out
}

/// `segments` below `root` on `side`.
fn path_on(side: &Side, root: &str, segments: &[String]) -> String {
    segments
        .iter()
        .fold(root.to_string(), |path, name| side.join(&path, name))
}

/// How a run's deletes went.
#[derive(Debug, Default)]
struct DeleteReport {
    deleted: usize,
    /// Not deleted: changed since the plan, failed, or not tried.
    kept: usize,
    note: Option<String>,
}

impl Core {
    /// Plans live this long (default [`PLAN_TTL`]; tests shorten it).
    pub fn set_sync_plan_ttl(&self, ttl: Duration) {
        *self.inner.sync.ttl.lock().expect(LOCK_POISONED) = ttl;
    }

    /// Compare the local folder `local_dir` with the remote folder
    /// `remote_dir` of a session for a sync in `direction` (`upload`: Local
    /// → Remote). Walks both recursively and returns the plan (see the
    /// module docs), kept for [`Core::run_sync`] until it expires.
    ///
    /// `NotConnected` without a live session, `NotFound` when a folder is
    /// missing, `InvalidInput` for an empty path or bad options.
    pub async fn plan_sync(
        &self,
        session_id: SessionId,
        direction: TransferDirection,
        local_dir: &str,
        remote_dir: &str,
        options: SyncOptions,
    ) -> CoreResult<SyncPlan> {
        if local_dir.trim().is_empty() || remote_dir.trim().is_empty() {
            return Err(CoreError::InvalidInput(
                "a folder to sync is missing".into(),
            ));
        }
        if let Some(mb) = options.max_file_size_mb {
            if !(1..=MAX_FILE_SIZE_MB_LIMIT).contains(&mb) {
                return Err(CoreError::InvalidInput(format!(
                    "the size limit must be between 1 and {MAX_FILE_SIZE_MB_LIMIT} MB"
                )));
            }
        }
        let excludes = match options.excludes.clone() {
            Some(patterns) => normalize_excludes(patterns)?,
            None => self.settings().sync_excludes,
        };
        let rules = DiffRules {
            mode: options.mode,
            rule: options.rule,
            protect_newer: options.protect_newer,
            skip_hidden: options.skip_hidden,
            max_file_size_mb: options.max_file_size_mb,
            excludes,
        };
        let live = self.inner.sessions.get(session_id)?;
        let local = Side::Local(self.local());
        let remote = Side::Remote(live.ssh.fs().clone());
        let prune = |name: &str, hidden: bool| {
            exclude::first_match(&rules.excludes, name).is_some()
                || (rules.skip_hidden && (hidden || is_dotfile(name)))
        };
        let (local_walk, remote_walk) = tokio::join!(
            walk(&local, local_dir, &prune),
            walk(&remote, remote_dir, &prune)
        );
        let remote_walk = self.forget_if_lost(session_id, live.generation, remote_walk)?;
        let local_walk = local_walk?;
        let (source, target) = match direction {
            TransferDirection::Upload => (local_walk, remote_walk),
            TransferDirection::Download => (remote_walk, local_walk),
        };
        let found = diff::diff(&source, &target, &rules);
        let plan = SyncPlan {
            plan_id: SyncPlanId::new(),
            session_id,
            direction,
            mode: options.mode,
            local_dir: local_dir.to_string(),
            remote_dir: remote_dir.to_string(),
            items: found.items,
            totals: found.totals,
        };
        tracing::info!(
            items = plan.items.len(),
            mode = ?plan.mode,
            "sync planned"
        );
        let ttl = self.inner.sync.ttl();
        let mut plans = self.inner.sync.plans.lock().expect(LOCK_POISONED);
        plans.retain(|_, p| p.created.elapsed() < ttl);
        plans.insert(
            plan.plan_id,
            StoredPlan {
                plan: plan.clone(),
                created: Instant::now(),
                copy_empty_folders: options.copy_empty_folders,
                target: target.into_iter().map(|l| (l.segments, l.node)).collect(),
            },
        );
        Ok(plan)
    }

    /// Run a plan, once: create the destination folders, queue the copies
    /// as one transfer batch (returned), and — in Mirror mode, after every
    /// copy succeeded — delete the target-only items that are unchanged
    /// since the plan. `ticked` lists the item paths to act on (`None`:
    /// the plan's defaults). [`CoreEvent::SyncFinished`] reports the end.
    ///
    /// `NotFound` for an unknown or expired plan (compare again),
    /// `InvalidInput` when nothing ticked does anything (the plan stays),
    /// `NotConnected` when its session is not connected. Must be called
    /// within a Tokio runtime.
    pub async fn run_sync(
        &self,
        plan_id: SyncPlanId,
        ticked: Option<Vec<String>>,
    ) -> CoreResult<BatchId> {
        let ticked: Option<HashSet<String>> = ticked.map(|t| t.into_iter().collect());
        let (stored, actions) = {
            let ttl = self.inner.sync.ttl();
            let mut plans = self.inner.sync.plans.lock().expect(LOCK_POISONED);
            let Some(stored) = plans.get(&plan_id) else {
                return Err(CoreError::NotFound(
                    "the comparison is gone; compare again".into(),
                ));
            };
            if stored.created.elapsed() >= ttl {
                plans.remove(&plan_id);
                return Err(CoreError::NotFound(
                    "the comparison has expired; compare again".into(),
                ));
            }
            let actions = actions(
                &stored.plan.items,
                ticked.as_ref(),
                stored.plan.mode,
                stored.copy_empty_folders,
            );
            if actions.copies.is_empty() && actions.mkdirs.is_empty() && actions.deletes.is_empty()
            {
                return Err(CoreError::InvalidInput("nothing to sync".into()));
            }
            (plans.remove(&plan_id).expect("looked up above"), actions)
        };
        let plan = &stored.plan;
        let session_id = plan.session_id;
        let live = self.inner.sessions.get(session_id)?;
        let local = Side::Local(self.local());
        let remote = Side::Remote(live.ssh.fs().clone());
        let (src, src_root, dst, dst_root, dst_target) = match plan.direction {
            TransferDirection::Upload => (
                &local,
                &plan.local_dir,
                &remote,
                &plan.remote_dir,
                FsTarget::Remote { session_id },
            ),
            TransferDirection::Download => (
                &remote,
                &plan.remote_dir,
                &local,
                &plan.local_dir,
                FsTarget::Local,
            ),
        };

        // Folders first, so every copy finds its folder.
        for dir in &actions.mkdirs {
            let path = path_on(dst, dst_root, dir);
            if let Err(e) = dst.mkdir_all(&path).await {
                if is_connection(&e) {
                    return self.forget_if_lost(session_id, live.generation, Err(e));
                }
                // The copies into it fail visibly (and stop the deletes).
                tracing::info!(kind = e.kind(), "a sync could not create a folder");
            }
        }
        let work = actions
            .copies
            .iter()
            .map(|(segments, resolution)| Work::Item {
                src: path_on(src, src_root, segments),
                dst_dir: path_on(dst, dst_root, &segments[..segments.len() - 1]),
                resolution: *resolution,
            })
            .collect();
        let batch_id = self
            .inner
            .transfers
            .enqueue_pinned(session_id, plan.direction, work)?;
        tracing::info!(
            copies = actions.copies.len(),
            deletes = actions.deletes.len(),
            "sync started"
        );
        let core = self.clone();
        let dst = dst.clone();
        let dst_root = dst_root.clone();
        tokio::spawn(async move {
            core.finish_sync(stored, batch_id, actions.deletes, dst, dst_root, dst_target)
                .await;
        });
        Ok(batch_id)
    }

    /// Forget a plan that will not run (the dialog closed). Unknown ids are
    /// ignored.
    pub fn discard_sync_plan(&self, plan_id: SyncPlanId) {
        self.inner
            .sync
            .plans
            .lock()
            .expect(LOCK_POISONED)
            .remove(&plan_id);
    }

    /// Wait for the copies of a run, then do its deletes (if any, and if
    /// every copy went well) and announce the end.
    async fn finish_sync(
        self,
        stored: StoredPlan,
        batch_id: BatchId,
        deletes: Vec<Delete>,
        dst: Side,
        dst_root: String,
        dst_target: FsTarget,
    ) {
        let outcome = self.batch_finished(batch_id).await;
        self.inner.transfers.unpin(batch_id);
        let report = if deletes.is_empty() {
            DeleteReport::default()
        } else if outcome.failed > 0 || outcome.cancelled > 0 {
            DeleteReport {
                kept: deletes.len(),
                note: Some("a copy failed or was cancelled, so nothing was deleted".into()),
                ..DeleteReport::default()
            }
        } else {
            self.inner.sync.deleting.fetch_add(1, Ordering::SeqCst);
            let report = self
                .delete_planned(&stored, &deletes, &dst, &dst_root, dst_target)
                .await;
            self.inner.sync.deleting.fetch_sub(1, Ordering::SeqCst);
            report
        };
        tracing::info!(
            copied = outcome.done,
            failed = outcome.failed,
            deleted = report.deleted,
            kept = report.kept,
            "sync finished"
        );
        self.inner.events.publish(CoreEvent::SyncFinished {
            plan_id: stored.plan.plan_id,
            batch_id,
            session_id: stored.plan.session_id,
            direction: stored.plan.direction,
            copied: outcome.done,
            skipped: outcome.skipped,
            failed: outcome.failed,
            cancelled: outcome.cancelled,
            deleted: report.deleted,
            kept: report.kept,
            note: report.note,
        });
    }

    /// The batch's outcome once every job in it is finished.
    async fn batch_finished(&self, batch_id: BatchId) -> BatchOutcome {
        // Subscribed before the first look, so no change slips between.
        let mut rx = self.subscribe_events();
        loop {
            match self.inner.transfers.batch_outcome(batch_id) {
                Some(outcome) if !outcome.finished => {}
                Some(outcome) => return outcome,
                None => {
                    return BatchOutcome {
                        finished: true,
                        ..BatchOutcome::default()
                    }
                }
            }
            // Look again when the batch changed (or now and then: the
            // events are only a hint).
            loop {
                let event = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await;
                match event {
                    Ok(Ok(CoreEvent::TransferJobChanged { job })) if job.batch_id == batch_id => {
                        break
                    }
                    Ok(Ok(CoreEvent::TransfersUpdated))
                    | Ok(Err(RecvError::Lagged(_)))
                    | Err(_) => break,
                    Ok(Err(RecvError::Closed)) => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        break;
                    }
                    Ok(Ok(_)) => {}
                }
            }
        }
    }

    /// Delete the target-only items, each only if it is what the plan saw.
    async fn delete_planned(
        &self,
        stored: &StoredPlan,
        deletes: &[Delete],
        dst: &Side,
        dst_root: &str,
        dst_target: FsTarget,
    ) -> DeleteReport {
        let mut report = DeleteReport::default();
        let mut changed = 0;
        for (index, delete) in deletes.iter().enumerate() {
            let path = path_on(dst, dst_root, delete.segments());
            let unchanged = match delete {
                Delete::File(segments) => {
                    file_unchanged(dst, &path, stored.target.get(segments)).await
                }
                Delete::Tree(segments) => {
                    tree_unchanged(dst, &path, segments, &stored.target).await
                }
                Delete::IfEmpty(_) => dst.list(&path).await.map(|e| e.is_empty()),
            };
            let unchanged = match unchanged {
                Ok(unchanged) => unchanged,
                Err(e) if is_connection(&e) => {
                    report.kept += deletes.len() - index;
                    report.note = Some("the connection was lost before every delete".into());
                    return report;
                }
                // Gone already, or unreadable: leave it.
                Err(_) => false,
            };
            if !unchanged {
                if !matches!(delete, Delete::IfEmpty(_)) {
                    changed += 1;
                }
                report.kept += 1;
                continue;
            }
            match self.delete(dst_target, std::slice::from_ref(&path)).await {
                Ok(batch) if batch.failed.is_empty() => report.deleted += 1,
                Ok(_) => report.kept += 1,
                Err(_) => {
                    report.kept += deletes.len() - index;
                    report.note = Some("the connection was lost before every delete".into());
                    return report;
                }
            }
        }
        if changed > 0 {
            report.note = Some(format!(
                "{changed} {} changed since the comparison and {} kept",
                if changed == 1 { "item" } else { "items" },
                if changed == 1 { "was" } else { "were" },
            ));
        }
        report
    }
}

/// Whether the file at `path` still has the planned size and date.
async fn file_unchanged(side: &Side, path: &str, planned: Option<&Node>) -> CoreResult<bool> {
    let Some(Node::File { size, mtime }) = planned else {
        return Ok(false);
    };
    Ok(match side.metadata(path).await? {
        Some(meta) => !meta.is_dir && meta.size == *size && meta.mtime == *mtime,
        None => false,
    })
}

/// Whether the folder at `path` holds exactly what the plan saw under
/// `segments` (every entry, excluded or hidden ones included: they would
/// be deleted with it).
async fn tree_unchanged(
    side: &Side,
    path: &str,
    segments: &[String],
    planned: &HashMap<Vec<String>, Node>,
) -> CoreResult<bool> {
    if !matches!(planned.get(segments), Some(Node::Dir)) {
        return Ok(false);
    }
    let now = walk(side, path, &|_, _| false).await?;
    let before: HashMap<&[String], &Node> = planned
        .iter()
        .filter(|(k, _)| k.len() > segments.len() && k.starts_with(segments))
        .map(|(k, v)| (&k[segments.len()..], v))
        .collect();
    Ok(now.len() == before.len()
        && now
            .iter()
            .all(|l| before.get(l.segments.as_slice()) == Some(&&l.node)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(path: &str, kind: SyncItemKind, group: SyncGroup, selected: bool) -> SyncItem {
        SyncItem {
            path: path.into(),
            kind,
            group,
            src_size: None,
            src_mtime: None,
            dst_size: None,
            dst_mtime: None,
            reason: None,
            selected,
            segments: path.split('/').map(String::from).collect(),
            whole: kind == SyncItemKind::Dir && group == SyncGroup::TargetOnly,
        }
    }

    fn segs(path: &str) -> Vec<String> {
        path.split('/').map(String::from).collect()
    }

    use SyncGroup::*;
    use SyncItemKind::{Dir, File};

    #[test]
    fn copies_new_without_and_changed_with_a_replace_answer() {
        let items = [
            item("a.txt", File, New, true),
            item("b.txt", File, Changed, true),
            item("c.txt", File, TargetNewer, false),
            item("d/e.txt", File, DifferentSizeSameDate, false),
        ];
        let a = actions(&items, None, SyncMode::Update, true);
        assert_eq!(
            a.copies,
            vec![
                (segs("a.txt"), None),
                (segs("b.txt"), Some(ConflictResolution::Replace)),
            ]
        );
        let ticked: HashSet<String> = ["c.txt", "d/e.txt"].map(String::from).into();
        let a = actions(&items, Some(&ticked), SyncMode::Update, true);
        assert_eq!(
            a.copies,
            vec![
                (segs("c.txt"), Some(ConflictResolution::Replace)),
                (segs("d/e.txt"), Some(ConflictResolution::Replace)),
            ]
        );
        assert_eq!(a.mkdirs, vec![segs("d")]);
    }

    #[test]
    fn only_the_deepest_folders_are_made_and_empty_ones_on_request() {
        let items = [
            item("x", Dir, New, true),
            item("x/y", Dir, New, true),
            item("x/y/f.txt", File, New, true),
            item("empty", Dir, New, true),
        ];
        let a = actions(&items, None, SyncMode::Update, true);
        assert_eq!(a.mkdirs, vec![segs("empty"), segs("x/y")]);
        let a = actions(&items, None, SyncMode::Update, false);
        assert_eq!(a.mkdirs, vec![segs("x/y")]);
    }

    #[test]
    fn update_never_deletes() {
        let items = [item("old.txt", File, TargetOnly, true)];
        let a = actions(&items, None, SyncMode::Update, true);
        assert!(a.deletes.is_empty());
    }

    #[test]
    fn mirror_deletes_whole_folders_deepest_first() {
        let items = [
            item("gone", Dir, TargetOnly, true),
            item("gone/a.txt", File, TargetOnly, true),
            item("keep", Dir, TargetOnly, true),
            item("keep/b.txt", File, TargetOnly, true),
            item("keep/c.txt", File, TargetOnly, true),
            item("z.txt", File, TargetOnly, true),
        ];
        // `keep/c.txt` unticked: `keep` cannot go as a whole.
        let ticked: HashSet<String> = ["gone", "gone/a.txt", "keep", "keep/b.txt", "z.txt"]
            .map(String::from)
            .into();
        let a = actions(&items, Some(&ticked), SyncMode::Mirror, true);
        assert_eq!(
            a.deletes,
            vec![
                Delete::File(segs("keep/b.txt")),
                Delete::Tree(segs("gone")),
                Delete::IfEmpty(segs("keep")),
                Delete::File(segs("z.txt")),
            ]
        );
    }

    #[test]
    fn a_folder_with_blocked_contents_is_only_removed_when_empty() {
        let mut dir = item("old", Dir, TargetOnly, true);
        dir.whole = false;
        let items = [dir, item("old/a.txt", File, TargetOnly, true)];
        let a = actions(&items, None, SyncMode::Mirror, true);
        assert_eq!(
            a.deletes,
            vec![
                Delete::File(segs("old/a.txt")),
                Delete::IfEmpty(segs("old"))
            ]
        );
    }

    #[test]
    fn options_parse_with_defaults() {
        let o: SyncOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(o, SyncOptions::default());
        assert!(o.protect_newer && o.copy_empty_folders && !o.skip_hidden);
        let unknown = serde_json::from_value::<SyncOptions>(serde_json::json!({
            "rule": "differentSizeSameDate",
        }));
        assert!(unknown.is_err(), "not a rule");
        let o: SyncOptions = serde_json::from_value(serde_json::json!({
            "mode": "mirror",
            "rule": "newerOnly",
            "skipHidden": true,
            "maxFileSizeMb": 5,
            "excludes": ["*.tmp"],
        }))
        .unwrap();
        assert_eq!(o.mode, SyncMode::Mirror);
        assert_eq!(o.rule, CompareRule::NewerOnly);
        assert_eq!(o.max_file_size_mb, Some(5));
        assert_eq!(o.excludes, Some(vec!["*.tmp".to_string()]));
    }

    #[test]
    fn plans_are_camel_case_on_the_wire() {
        let mut totals = SyncTotals::default();
        let mut it = item("docs/a.txt", File, DifferentSizeSameDate, false);
        it.src_size = Some(3);
        totals.add(&it);
        let plan = SyncPlan {
            plan_id: SyncPlanId::new(),
            session_id: SessionId::new(),
            direction: TransferDirection::Upload,
            mode: SyncMode::Mirror,
            local_dir: "/home/demo/site".into(),
            remote_dir: "/srv/site".into(),
            items: vec![it],
            totals,
        };
        let json = serde_json::to_value(&plan).unwrap();
        assert_eq!(json["mode"], "mirror");
        assert_eq!(json["localDir"], "/home/demo/site");
        let item = &json["items"][0];
        assert_eq!(item["group"], "differentSizeSameDate");
        assert_eq!(item["kind"], "file");
        assert_eq!(item["srcSize"], 3);
        assert!(item["dstMtime"].is_null());
        assert!(item.get("segments").is_none());
        assert!(item.get("whole").is_none());
        assert_eq!(
            json["totals"]["differentSizeSameDate"],
            serde_json::json!({ "files": 1, "dirs": 0, "bytes": 3 })
        );
        assert_eq!(json["totals"].as_object().unwrap().len(), 9);
        assert_eq!(json["totals"]["targetOnly"]["files"], 0);
    }
}
