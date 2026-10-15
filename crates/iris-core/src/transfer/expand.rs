//! Turning the selected items of a batch into per-file jobs, off the IPC
//! call path. Folders are walked depth-first; each destination folder is
//! created before the files inside it are queued, so a job never waits
//! for its parent folder.

use std::sync::Arc;
use std::time::Instant;

use tokio_util::sync::CancellationToken;

use crate::error::CoreError;
use crate::events::CoreEvent;
use crate::fs::{EntryKind, LinkTargetKind, SftpFs};
use crate::ids::BatchId;

use super::naming::is_safe_name;
use super::progress::{Throttle, PROGRESS_INTERVAL};
use super::side::Side;
use super::{NewJob, Shared, TransferDirection, TransferError, TransferRequest, TransferState};

pub(super) async fn run(
    shared: Arc<Shared>,
    batch_id: BatchId,
    request: TransferRequest,
    remote: SftpFs,
    token: CancellationToken,
) {
    let remote = Side::Remote(remote);
    let local = Side::Local(shared.local());
    let (src, dst) = match request.direction {
        TransferDirection::Upload => (local, remote),
        TransferDirection::Download => (remote, local),
    };
    let mut walker = Walker {
        shared: &shared,
        batch_id,
        request: &request,
        src: &src,
        dst: &dst,
        token: &token,
        updates: Throttle::new(PROGRESS_INTERVAL),
    };
    for item in &request.items {
        if token.is_cancelled() {
            break;
        }
        walker.item(&item.src).await;
    }
    shared.expansion_done(batch_id);
}

struct Walker<'a> {
    shared: &'a Arc<Shared>,
    batch_id: BatchId,
    request: &'a TransferRequest,
    src: &'a Side,
    dst: &'a Side,
    token: &'a CancellationToken,
    /// Coalesces the "list changed" signal while jobs pour in.
    updates: Throttle,
}

/// Why an entry is not copied.
const DIR_LINK: &str = "links to folders are not copied";
const BROKEN_LINK: &str = "the link is broken";
const SPECIAL: &str = "only files and folders are copied";
const UNSAFE_NAME: &str = "the name is not a valid file name";

impl Walker<'_> {
    /// One selected item. A selected link is followed (folders included:
    /// the user picked it); links met inside a folder are not (see
    /// [`Walker::folder`]).
    async fn item(&mut self, path: &str) {
        let name = self.src.name_of(path);
        let dst_dir = self.request.dst_dir.clone();
        if !is_safe_name(&name) {
            self.skip(path, &dst_dir, &name, UNSAFE_NAME);
            return;
        }
        match self.src.entry(path).await {
            Err(e) => self.fail(path, &dst_dir, &name, &e),
            Ok(entry) => match entry.kind {
                EntryKind::File => self.file(path, &dst_dir, &name, entry.size),
                EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::File),
                    ..
                } => self.file(path, &dst_dir, &name, 0),
                EntryKind::Dir
                | EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::Dir),
                    ..
                } => self.folder(path, &dst_dir, &name).await,
                EntryKind::Symlink {
                    target_kind: None, ..
                } => self.skip(path, &dst_dir, &name, BROKEN_LINK),
                EntryKind::Other => self.skip(path, &dst_dir, &name, SPECIAL),
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
            if let Err(e) = self.dst.mkdir_all(&dst_dir).await {
                self.fail(&src_dir, &dst_parent, &name, &e);
                continue;
            }
            let mut entries = match self.src.list(&src_dir).await {
                Ok(entries) => entries,
                Err(e) => {
                    self.fail(&src_dir, &dst_parent, &name, &e);
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
        self.add(src, dst_dir, name, size, None);
    }

    fn skip(&mut self, src: &str, dst_dir: &str, name: &str, why: &str) {
        let error = TransferError {
            kind: "invalidInput".into(),
            message: format!("{src}: {why}"),
        };
        self.add(src, dst_dir, name, 0, Some((TransferState::Skipped, error)));
    }

    fn fail(&mut self, src: &str, dst_dir: &str, name: &str, err: &CoreError) {
        tracing::info!(kind = err.kind(), "could not expand a transfer item");
        let error = TransferError::from(err);
        self.add(src, dst_dir, name, 0, Some((TransferState::Failed, error)));
    }

    fn add(
        &mut self,
        src: &str,
        dst_dir: &str,
        name: &str,
        size: u64,
        finished: Option<(TransferState, TransferError)>,
    ) {
        let dst = if is_safe_name(name) {
            self.dst.join(dst_dir, name)
        } else {
            dst_dir.to_string()
        };
        let added = self.shared.add_job(NewJob {
            batch_id: self.batch_id,
            session_id: self.request.session_id,
            direction: self.request.direction,
            src: src.to_string(),
            dst_dir: dst_dir.to_string(),
            name: name.to_string(),
            dst,
            size,
            finished,
        });
        if added && self.updates.ready(Instant::now()) {
            self.shared.publish(CoreEvent::TransfersUpdated);
        }
    }
}
