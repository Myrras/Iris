//! Turning the selected items of a batch into per-file jobs, off the IPC
//! call path. Folders are walked depth-first; each destination folder is
//! created before the files inside it are queued, so a job never waits
//! for its parent folder.
//!
//! When the connection goes mid-walk, the walk stops touching the network
//! and records what is left as paused placeholders (see the module docs of
//! [`super`]); a resume walks them again.

use std::sync::Arc;
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use crate::error::CoreError;
use crate::events::CoreEvent;
use crate::fs::{EntryKind, LinkTargetKind, SftpFs};
use crate::ids::{BatchId, SessionId};

use super::naming::is_safe_name;
use super::progress::{Throttle, PROGRESS_INTERVAL};
use super::side::Side;
use super::{NewJob, Shared, TransferDirection, TransferError, TransferState, Walk};

/// One piece of a walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Work {
    /// A selected item, copied into `dst_dir` under its own name.
    Item { src: String, dst_dir: String },
    /// The folder `src`, created as `dst_parent/name` and filled.
    Folder {
        src: String,
        dst_parent: String,
        name: String,
    },
}

pub(super) async fn run(
    shared: Arc<Shared>,
    batch_id: BatchId,
    session_id: SessionId,
    direction: TransferDirection,
    work: Vec<Work>,
    remote: SftpFs,
    token: CancellationToken,
) {
    let remote = Side::Remote(remote);
    let local = Side::Local(shared.local());
    let (src, dst) = match direction {
        TransferDirection::Upload => (local, remote),
        TransferDirection::Download => (remote, local),
    };
    let mut walker = Walker {
        shared: &shared,
        batch_id,
        session_id,
        direction,
        src: &src,
        dst: &dst,
        token: &token,
        updates: Throttle::new(PROGRESS_INTERVAL),
        stopped: false,
    };
    for piece in work {
        if token.is_cancelled() {
            break;
        }
        if walker.stopped {
            walker.placeholder(piece);
            continue;
        }
        match piece {
            Work::Item { src, dst_dir } => walker.item(&src, &dst_dir).await,
            Work::Folder {
                src,
                dst_parent,
                name,
            } => walker.folder(&src, &dst_parent, &name).await,
        }
    }
    shared.expansion_done(batch_id);
}

struct Walker<'a> {
    shared: &'a Arc<Shared>,
    batch_id: BatchId,
    session_id: SessionId,
    direction: TransferDirection,
    src: &'a Side,
    dst: &'a Side,
    token: &'a CancellationToken,
    /// Coalesces the "list changed" signal while jobs pour in.
    updates: Throttle,
    /// The connection is gone: what is left becomes placeholders.
    stopped: bool,
}

/// Why an entry is not copied.
const DIR_LINK: &str = "links to folders are not copied";
const BROKEN_LINK: &str = "the link is broken";
const SPECIAL: &str = "only files and folders are copied";
const UNSAFE_NAME: &str = "the name is not a valid file name";

impl Walker<'_> {
    /// Whether `err` means the connection is gone (rather than this one
    /// entry being a problem); see [`Shared::connection_gone`].
    async fn lost(&self, err: &CoreError) -> bool {
        self.shared.connection_gone(self.session_id, err).await
    }

    /// One selected item. A selected link is followed (folders included:
    /// the user picked it); links met inside a folder are not (see
    /// [`Walker::folder`]).
    async fn item(&mut self, path: &str, dst_dir: &str) {
        let name = self.src.name_of(path);
        if !is_safe_name(&name) {
            self.skip(path, dst_dir, &name, UNSAFE_NAME);
            return;
        }
        match self.src.entry(path).await {
            Err(e) if self.lost(&e).await => {
                self.stopped = true;
                self.placeholder(Work::Item {
                    src: path.to_string(),
                    dst_dir: dst_dir.to_string(),
                });
            }
            Err(e) => self.fail(path, dst_dir, &name, &e, Walk::Item),
            Ok(entry) => match entry.kind {
                EntryKind::File => self.file(path, dst_dir, &name, entry.size),
                EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::File),
                    ..
                } => self.file(path, dst_dir, &name, 0),
                EntryKind::Dir
                | EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::Dir),
                    ..
                } => self.folder(path, dst_dir, &name).await,
                EntryKind::Symlink {
                    target_kind: None, ..
                } => self.skip(path, dst_dir, &name, BROKEN_LINK),
                EntryKind::Other => self.skip(path, dst_dir, &name, SPECIAL),
            },
        }
    }

    /// Walk the folder `root` into `dst_parent/name`, depth-first.
    async fn folder(&mut self, root: &str, dst_parent: &str, name: &str) {
        let mut stack = vec![(root.to_string(), dst_parent.to_string(), name.to_string())];
        while let Some((src_dir, dst_parent, name)) = stack.pop() {
            if self.token.is_cancelled() {
                return;
            }
            let dst_dir = self.dst.join(&dst_parent, &name);
            let listed = match self.dst.mkdir_all(&dst_dir).await {
                Ok(()) => self.src.list(&src_dir).await,
                Err(e) => Err(e),
            };
            let mut entries = match listed {
                Ok(entries) => entries,
                Err(e) if self.lost(&e).await => {
                    // This folder and every one still on the stack wait for
                    // the connection to come back.
                    self.stopped = true;
                    stack.push((src_dir, dst_parent, name));
                    while let Some((src, dst_parent, name)) = stack.pop() {
                        self.placeholder(Work::Folder {
                            src,
                            dst_parent,
                            name,
                        });
                    }
                    return;
                }
                Err(e) => {
                    self.fail(&src_dir, &dst_parent, &name, &e, Walk::Folder);
                    continue;
                }
            };
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            let mut subfolders = Vec::new();
            for entry in entries {
                if !is_safe_name(&entry.name) {
                    self.skip(&entry.path, &dst_dir, &entry.name, UNSAFE_NAME);
                    continue;
                }
                match entry.kind {
                    EntryKind::File => self.file(&entry.path, &dst_dir, &entry.name, entry.size),
                    EntryKind::Symlink {
                        target_kind: Some(LinkTargetKind::File),
                        ..
                    } => self.file(&entry.path, &dst_dir, &entry.name, 0),
                    EntryKind::Dir => subfolders.push(entry),
                    // Following folder links could loop back up the tree.
                    EntryKind::Symlink {
                        target_kind: Some(LinkTargetKind::Dir),
                        ..
                    } => self.skip(&entry.path, &dst_dir, &entry.name, DIR_LINK),
                    EntryKind::Symlink {
                        target_kind: None, ..
                    } => self.skip(&entry.path, &dst_dir, &entry.name, BROKEN_LINK),
                    EntryKind::Other => self.skip(&entry.path, &dst_dir, &entry.name, SPECIAL),
                }
            }
            // Reversed so the stack pops them in name order.
            for sub in subfolders.into_iter().rev() {
                stack.push((sub.path, dst_dir.clone(), sub.name));
            }
        }
    }

    fn file(&mut self, src: &str, dst_dir: &str, name: &str, size: u64) {
        self.add(src, dst_dir, name, size, TransferState::Queued, None, None);
    }

    fn skip(&mut self, src: &str, dst_dir: &str, name: &str, why: &str) {
        let error = TransferError {
            kind: "invalidInput".into(),
            message: format!("{src}: {why}"),
        };
        let state = TransferState::Skipped;
        self.add(src, dst_dir, name, 0, state, Some(error), None);
    }

    /// A `failed` placeholder: retrying it walks `src` again.
    fn fail(&mut self, src: &str, dst_dir: &str, name: &str, err: &CoreError, walk: Walk) {
        tracing::info!(kind = err.kind(), "could not expand a transfer item");
        let error = TransferError::from(err);
        let state = TransferState::Failed;
        self.add(src, dst_dir, name, 0, state, Some(error), Some(walk));
    }

    /// A `paused` placeholder for work the lost connection cut off.
    fn placeholder(&mut self, work: Work) {
        let state = TransferState::Paused;
        match work {
            Work::Item { src, dst_dir } => {
                let name = self.src.name_of(&src);
                self.add(&src, &dst_dir, &name, 0, state, None, Some(Walk::Item));
            }
            Work::Folder {
                src,
                dst_parent,
                name,
            } => {
                let walk = Some(Walk::Folder);
                self.add(&src, &dst_parent, &name, 0, state, None, walk);
            }
        }
    }

    #[allow(clippy::too_many_arguments)] // one job's fields, passed through
    fn add(
        &mut self,
        src: &str,
        dst_dir: &str,
        name: &str,
        size: u64,
        state: TransferState,
        error: Option<TransferError>,
        walk: Option<Walk>,
    ) {
        let dst = if is_safe_name(name) {
            self.dst.join(dst_dir, name)
        } else {
            dst_dir.to_string()
        };
        let added = self.shared.add_job(NewJob {
            batch_id: self.batch_id,
            session_id: self.session_id,
            direction: self.direction,
            src: src.to_string(),
            dst_dir: dst_dir.to_string(),
            name: name.to_string(),
            dst,
            size,
            state,
            error,
            walk,
        });
        if added && self.updates.ready(Instant::now()) {
            self.shared.publish(CoreEvent::TransfersUpdated);
        }
    }
}
