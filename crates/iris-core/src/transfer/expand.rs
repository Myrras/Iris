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
use crate::fs::walk::{FolderWalk, REMOTE_WALK_CHANNELS};
use crate::fs::{EntryKind, LinkTargetKind, SftpFs};
use crate::ids::{BatchId, SessionId};

use super::naming::is_safe_name;
use super::progress::{Throttle, PROGRESS_INTERVAL};
use super::side::Side;
use super::{
    ConflictResolution, NewJob, Shared, TransferDirection, TransferError, TransferState, Walk,
    BROKEN_LINK, DIR_LINK, SPECIAL, UNSAFE_NAME,
};

/// One piece of a walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Work {
    /// A selected item, copied into `dst_dir` under its own name. A file
    /// found for it starts with `resolution` as its conflict answer (a sync
    /// overwrites the files it found changed without asking).
    Item {
        src: String,
        dst_dir: String,
        resolution: Option<ConflictResolution>,
    },
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
    // A remote source is listed over a few pooled channels besides the
    // session's own; they go back to the pool afterwards.
    let mut pooled = Vec::new();
    if direction == TransferDirection::Download {
        for _ in 1..REMOTE_WALK_CHANNELS {
            match shared.take_channel(session_id).await {
                Ok(channel) => pooled.push(channel),
                Err(_) => break,
            }
        }
    }
    let remote_side = Side::Remote(remote);
    let local = Side::Local(shared.local());
    let (src, dst) = match direction {
        TransferDirection::Upload => (local, remote_side),
        TransferDirection::Download => (remote_side, local),
    };
    let listers: Vec<Side> = std::iter::once(src.clone())
        .chain(pooled.iter().cloned().map(Side::Remote))
        .collect();
    let mut walker = Walker {
        shared: &shared,
        batch_id,
        session_id,
        direction,
        src: &src,
        dst: &dst,
        listers,
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
            Work::Item {
                src,
                dst_dir,
                resolution,
            } => walker.item(&src, &dst_dir, resolution).await,
            Work::Folder {
                src,
                dst_parent,
                name,
            } => walker.folder(&src, &dst_parent, &name).await,
        }
    }
    for channel in pooled {
        shared.return_channel(session_id, channel);
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
    /// What folders of the source are listed from (several channels for a
    /// remote source).
    listers: Vec<Side>,
    token: &'a CancellationToken,
    /// Coalesces the "list changed" signal while jobs pour in.
    updates: Throttle,
    /// The connection is gone: what is left becomes placeholders.
    stopped: bool,
}

impl Walker<'_> {
    /// Whether `err` means the connection is gone (rather than this one
    /// entry being a problem); see [`Shared::connection_gone`].
    async fn lost(&self, err: &CoreError) -> bool {
        self.shared.connection_gone(self.session_id, err).await
    }

    /// One selected item. A selected link is followed (folders included:
    /// the user picked it); links met inside a folder are not (see
    /// [`Walker::folder`]).
    async fn item(&mut self, path: &str, dst_dir: &str, resolution: Option<ConflictResolution>) {
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
                    resolution,
                });
            }
            Err(e) => {
                tracing::info!(kind = e.kind(), "could not expand a transfer item");
                let error = Some(TransferError::from(&e));
                let state = TransferState::Failed;
                let walk = Some(Walk::Item);
                self.add(path, dst_dir, &name, 0, state, error, walk, resolution);
            }
            Ok(entry) => match entry.kind {
                EntryKind::File => {
                    let state = TransferState::Queued;
                    self.add(
                        path, dst_dir, &name, entry.size, state, None, None, resolution,
                    );
                }
                EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::File),
                    ..
                } => {
                    let state = TransferState::Queued;
                    self.add(path, dst_dir, &name, 0, state, None, None, resolution);
                }
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

    /// Walk the folder `root` into `dst_parent/name`, several folders at
    /// once. A folder's destination is made before its files are queued
    /// and its subfolders are listed.
    async fn folder(&mut self, root: &str, dst_parent: &str, name: &str) {
        // (destination parent, name, whether the parent was made by this
        // walk: then a plain mkdir does)
        let mut walk: FolderWalk<Side, (String, String, bool)> =
            FolderWalk::new(self.listers.clone(), self.src.walk_limit())
                .with_cancel(self.token.clone());
        walk.push(
            root.to_string(),
            (dst_parent.to_string(), name.to_string(), false),
        );
        while let Some(listing) = walk.next().await {
            let src_dir = listing.path;
            let (dst_parent, name, parent_made) = listing.tag;
            let dst_dir = self.dst.join(&dst_parent, &name);
            let listed = match listing.entries {
                Ok(entries) => {
                    let made = if parent_made {
                        self.dst.mkdir_one(&dst_dir).await
                    } else {
                        self.dst.mkdir_all(&dst_dir).await
                    };
                    made.map(|()| entries)
                }
                Err(e) => Err(e),
            };
            let mut entries = match listed {
                Ok(entries) => entries,
                Err(e) if self.lost(&e).await => {
                    // This folder and every one not listed yet wait for the
                    // connection to come back.
                    self.stopped = true;
                    self.placeholder(Work::Folder {
                        src: src_dir,
                        dst_parent,
                        name,
                    });
                    for (src, (dst_parent, name, _)) in walk.into_pending() {
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
            entries.sort_by(|a, b| a.entry.name.cmp(&b.entry.name));
            for walked in entries {
                let entry = walked.entry;
                if !is_safe_name(&entry.name) {
                    self.skip(&entry.path, &dst_dir, &entry.name, UNSAFE_NAME);
                    continue;
                }
                match entry.kind {
                    EntryKind::File => self.file(&entry.path, &dst_dir, &entry.name, entry.size),
                    EntryKind::Symlink {
                        target_kind: Some(LinkTargetKind::File),
                        ..
                    } => match walked.target {
                        Some(meta) if !meta.is_dir => {
                            self.file(&entry.path, &dst_dir, &entry.name, meta.size)
                        }
                        _ => self.skip(&entry.path, &dst_dir, &entry.name, BROKEN_LINK),
                    },
                    EntryKind::Dir => {
                        walk.push(entry.path, (dst_dir.clone(), entry.name, true));
                    }
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
        }
    }

    fn file(&mut self, src: &str, dst_dir: &str, name: &str, size: u64) {
        self.add(
            src,
            dst_dir,
            name,
            size,
            TransferState::Queued,
            None,
            None,
            None,
        );
    }

    fn skip(&mut self, src: &str, dst_dir: &str, name: &str, why: &str) {
        let error = TransferError {
            kind: "invalidInput".into(),
            message: format!("{src}: {why}"),
        };
        let state = TransferState::Skipped;
        self.add(src, dst_dir, name, 0, state, Some(error), None, None);
    }

    /// A `failed` placeholder: retrying it walks `src` again.
    fn fail(&mut self, src: &str, dst_dir: &str, name: &str, err: &CoreError, walk: Walk) {
        tracing::info!(kind = err.kind(), "could not expand a transfer item");
        let error = TransferError::from(err);
        let state = TransferState::Failed;
        self.add(src, dst_dir, name, 0, state, Some(error), Some(walk), None);
    }

    /// A `paused` placeholder for work the lost connection cut off.
    fn placeholder(&mut self, work: Work) {
        let state = TransferState::Paused;
        match work {
            Work::Item {
                src,
                dst_dir,
                resolution,
            } => {
                let name = self.src.name_of(&src);
                let walk = Some(Walk::Item);
                self.add(&src, &dst_dir, &name, 0, state, None, walk, resolution);
            }
            Work::Folder {
                src,
                dst_parent,
                name,
            } => {
                let walk = Some(Walk::Folder);
                self.add(&src, &dst_parent, &name, 0, state, None, walk, None);
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
        resolution: Option<ConflictResolution>,
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
            resolution,
        });
        if added && self.updates.ready(Instant::now()) {
            self.shared.publish(CoreEvent::TransfersUpdated);
        }
    }
}
