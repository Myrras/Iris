//! Turning the selected items of a batch into per-file jobs, off the IPC
//! call path: **count first, then copy**.
//!
//! 1. **Count**: the selected items are looked at (several at once) and
//!    folders walked with several listings in flight ([`crate::fs::walk`]).
//!    Nothing is queued yet; the batch is in its `counting` phase and
//!    [`CoreEvent::BatchCounting`] reports the files, bytes and folders
//!    found so far, so the UI can say what is coming instead of a total
//!    that keeps growing.
//! 2. **Folders**: every destination folder is made, parents first (one
//!    level at a time, several at once), so no job waits for its folder. A
//!    folder that cannot be made becomes a `failed` placeholder (retrying
//!    walks it again) and nothing under it is queued.
//! 3. **Jobs**: all jobs are added at once, in path order, with their
//!    sizes known; the batch is `transferring` and the workers start.
//!
//! When the connection goes during 1 or 2, the count stops and keeps what
//! it found and what it had not listed yet; the batch stays `counting`
//! (paused) and [`super::TransferManager::resume_paused_on`] continues the
//! count on the new connection. A placeholder that is retried (a folder
//! that could not be listed or made) is counted the same way.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::error::{CoreError, CoreResult};
use crate::fs::walk::{FolderWalk, REMOTE_WALK_CHANNELS};
use crate::fs::{Entry, EntryKind, FileMeta, LinkTargetKind, SftpFs};
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

/// Where a found entry goes in the job list: the piece of work it came
/// from, then its path below that piece.
type Key = (usize, Vec<String>);

/// Work still to count, with where its findings sort.
#[derive(Debug, Clone)]
pub(crate) enum Pending {
    Item {
        key: Key,
        src: String,
        dst_dir: String,
        resolution: Option<ConflictResolution>,
    },
    Folder(FolderTag, String),
}

/// A folder to list (its source path travels next to it).
#[derive(Debug, Clone)]
pub(crate) struct FolderTag {
    key: Key,
    /// 0 for the folder of a piece of work (made with `mkdir -p`), its
    /// parent's level + 1 below.
    level: usize,
    dst_parent: String,
    name: String,
}

impl Pending {
    /// The pending work for a batch's pieces.
    pub(crate) fn from_work(work: Vec<Work>) -> Vec<Pending> {
        work.into_iter()
            .enumerate()
            .map(|(index, piece)| match piece {
                Work::Item {
                    src,
                    dst_dir,
                    resolution,
                } => Pending::Item {
                    key: (index, Vec::new()),
                    src,
                    dst_dir,
                    resolution,
                },
                Work::Folder {
                    src,
                    dst_parent,
                    name,
                } => Pending::Folder(
                    FolderTag {
                        key: (index, Vec::new()),
                        level: 0,
                        dst_parent,
                        name,
                    },
                    src,
                ),
            })
            .collect()
    }
}

/// A destination folder to make before the jobs are added.
#[derive(Debug, Clone)]
struct DirToMake {
    key: Key,
    level: usize,
    src: String,
    dst_parent: String,
    name: String,
    dst: String,
}

/// What a count found so far; kept while it waits for the connection.
#[derive(Debug, Default)]
pub(crate) struct Inventory {
    /// Every job to add (files to copy, and entries already skipped or
    /// failed), with where it sorts.
    jobs: Vec<(Key, NewJob)>,
    dirs: Vec<DirToMake>,
    pub files: u64,
    pub bytes: u64,
    pub folders: u64,
}

/// A count cut off by a lost connection: what it found, and what is left.
#[derive(Debug)]
pub(crate) struct PausedCount {
    pub inventory: Inventory,
    pub pending: Vec<Pending>,
}

pub(super) async fn run(
    shared: Arc<Shared>,
    batch_id: BatchId,
    session_id: SessionId,
    direction: TransferDirection,
    count: PausedCount,
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
    let mut counter = Counter {
        shared: &shared,
        batch_id,
        session_id,
        direction,
        src: &src,
        dst: &dst,
        listers,
        token: &token,
        inv: count.inventory,
        throttle: Throttle::new(PROGRESS_INTERVAL),
    };
    let outcome = counter.run(count.pending).await;
    for channel in pooled {
        shared.return_channel(session_id, channel);
    }
    match outcome {
        Outcome::Counted(jobs) => {
            shared.add_jobs(batch_id, session_id, jobs);
        }
        Outcome::Lost(pending) => {
            tracing::info!("the connection went while counting a transfer");
            shared.pause_count(
                batch_id,
                PausedCount {
                    inventory: counter.inv,
                    pending,
                },
            );
        }
        Outcome::Cancelled => {}
    }
    shared.expansion_done(batch_id);
}

enum Outcome {
    /// Everything was found and the folders are made: the jobs, in order.
    Counted(Vec<NewJob>),
    /// The connection went; what is left to count.
    Lost(Vec<Pending>),
    Cancelled,
}

struct Counter<'a> {
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
    inv: Inventory,
    /// Coalesces the counting events.
    throttle: Throttle,
}

/// A selected item, looked at.
struct Looked {
    entry: CoreResult<Entry>,
    /// For a link to a file: the file.
    target: Option<FileMeta>,
}

impl Counter<'_> {
    /// Whether `err` means the connection is gone (rather than this one
    /// entry being a problem); see [`Shared::connection_gone`].
    async fn lost(&self, err: &CoreError) -> bool {
        self.shared.connection_gone(self.session_id, err).await
    }

    async fn run(&mut self, pending: Vec<Pending>) -> Outcome {
        let mut items = Vec::new();
        let mut folders = Vec::new();
        for piece in pending {
            match piece {
                item @ Pending::Item { .. } => items.push(item),
                Pending::Folder(tag, src) => folders.push((src, tag)),
            }
        }
        if let Err(left) = self.items(items, &mut folders).await {
            return self.stop(left);
        }
        if let Err(left) = self.folders(folders).await {
            return self.stop(left);
        }
        self.announce(true);
        match self.make_dirs().await {
            Ok(failed) => Outcome::Counted(self.jobs(failed)),
            Err(()) if self.token.is_cancelled() => Outcome::Cancelled,
            Err(()) => Outcome::Lost(Vec::new()),
        }
    }

    fn stop(&self, left: Vec<Pending>) -> Outcome {
        if self.token.is_cancelled() {
            Outcome::Cancelled
        } else {
            Outcome::Lost(left)
        }
    }

    /// Look at the selected items, several at once. Folders among them
    /// join `folders`. `Err` with what is left when the connection went
    /// (or the batch was cancelled).
    async fn items(
        &mut self,
        items: Vec<Pending>,
        folders: &mut Vec<(String, FolderTag)>,
    ) -> Result<(), Vec<Pending>> {
        let limit = self.src.walk_limit();
        let mut looked: Vec<Option<Looked>> = (0..items.len()).map(|_| None).collect();
        let mut running = JoinSet::new();
        let mut next = 0;
        while next < items.len() || !running.is_empty() {
            while next < items.len() && running.len() < limit {
                if let Pending::Item { src: path, .. } = &items[next] {
                    let side = self.src.clone();
                    let path = path.clone();
                    let index = next;
                    running.spawn(async move { (index, look(&side, &path).await) });
                }
                next += 1;
            }
            let joined = tokio::select! {
                joined = running.join_next() => joined,
                () = self.token.cancelled() => return Err(Vec::new()),
            };
            if let Some(Ok((index, result))) = joined {
                looked[index] = Some(result);
            }
        }
        for (index, (item, result)) in items.iter().zip(looked).enumerate() {
            let Pending::Item {
                key,
                src: path,
                dst_dir,
                resolution,
            } = item
            else {
                continue;
            };
            let name = self.src.name_of(path);
            if !is_safe_name(&name) {
                self.skip(key.clone(), path, dst_dir, &name, UNSAFE_NAME);
                continue;
            }
            let Some(Looked { entry, target }) = result else {
                continue;
            };
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) if self.lost(&e).await => {
                    // This item and the rest wait for the connection; so do
                    // the folders found so far.
                    let mut left: Vec<Pending> = items[index..].to_vec();
                    left.extend(
                        folders
                            .drain(..)
                            .map(|(src, tag)| Pending::Folder(tag, src)),
                    );
                    return Err(left);
                }
                Err(e) => {
                    tracing::info!(kind = e.kind(), "could not count a transfer item");
                    let error = Some(TransferError::from(&e));
                    let state = TransferState::Failed;
                    let walk = Some(Walk::Item);
                    self.add(
                        key.clone(),
                        path,
                        dst_dir,
                        &name,
                        0,
                        state,
                        error,
                        walk,
                        *resolution,
                    );
                    continue;
                }
            };
            match entry.kind {
                EntryKind::File => {
                    self.file(key.clone(), path, dst_dir, &name, entry.size, *resolution)
                }
                EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::File),
                    ..
                } => match target {
                    Some(meta) if !meta.is_dir => {
                        self.file(key.clone(), path, dst_dir, &name, meta.size, *resolution)
                    }
                    _ => self.skip(key.clone(), path, dst_dir, &name, BROKEN_LINK),
                },
                // A selected link to a folder is followed: the user
                // picked it.
                EntryKind::Dir
                | EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::Dir),
                    ..
                } => folders.push((
                    path.clone(),
                    FolderTag {
                        key: key.clone(),
                        level: 0,
                        dst_parent: dst_dir.clone(),
                        name,
                    },
                )),
                EntryKind::Symlink {
                    target_kind: None, ..
                } => self.skip(key.clone(), path, dst_dir, &name, BROKEN_LINK),
                EntryKind::Other => self.skip(key.clone(), path, dst_dir, &name, SPECIAL),
            }
        }
        self.announce(false);
        Ok(())
    }

    /// Walk `folders`, several listings at once. `Err` with the folders
    /// not listed yet when the connection went (or the batch was
    /// cancelled).
    async fn folders(&mut self, folders: Vec<(String, FolderTag)>) -> Result<(), Vec<Pending>> {
        let mut walk: FolderWalk<Side, FolderTag> =
            FolderWalk::new(self.listers.clone(), self.src.walk_limit())
                .with_cancel(self.token.clone());
        for (src, tag) in folders {
            walk.push(src, tag);
        }
        while let Some(listing) = walk.next().await {
            let tag = listing.tag;
            let entries = match listing.entries {
                Ok(entries) => entries,
                Err(e) if self.lost(&e).await => {
                    // This folder and every one not listed yet wait for the
                    // connection to come back.
                    let mut left = vec![Pending::Folder(tag, listing.path)];
                    left.extend(
                        walk.into_pending()
                            .into_iter()
                            .map(|(src, tag)| Pending::Folder(tag, src)),
                    );
                    return Err(left);
                }
                Err(e) => {
                    self.fail_folder(&tag, &listing.path, &e);
                    continue;
                }
            };
            let dst_dir = self.dst.join(&tag.dst_parent, &tag.name);
            self.inv.folders += 1;
            self.inv.dirs.push(DirToMake {
                key: tag.key.clone(),
                level: tag.level,
                src: listing.path.clone(),
                dst_parent: tag.dst_parent.clone(),
                name: tag.name.clone(),
                dst: dst_dir.clone(),
            });
            for walked in entries {
                let entry = walked.entry;
                let mut rel = tag.key.1.clone();
                rel.push(entry.name.clone());
                let key = (tag.key.0, rel);
                if !is_safe_name(&entry.name) {
                    self.skip(key, &entry.path, &dst_dir, &entry.name, UNSAFE_NAME);
                    continue;
                }
                match entry.kind {
                    EntryKind::File => {
                        self.file(key, &entry.path, &dst_dir, &entry.name, entry.size, None)
                    }
                    EntryKind::Symlink {
                        target_kind: Some(LinkTargetKind::File),
                        ..
                    } => match walked.target {
                        Some(meta) if !meta.is_dir => {
                            self.file(key, &entry.path, &dst_dir, &entry.name, meta.size, None)
                        }
                        _ => self.skip(key, &entry.path, &dst_dir, &entry.name, BROKEN_LINK),
                    },
                    EntryKind::Dir => walk.push(
                        entry.path,
                        FolderTag {
                            key,
                            level: tag.level + 1,
                            dst_parent: dst_dir.clone(),
                            name: entry.name,
                        },
                    ),
                    // Following folder links could loop back up the tree.
                    EntryKind::Symlink {
                        target_kind: Some(LinkTargetKind::Dir),
                        ..
                    } => self.skip(key, &entry.path, &dst_dir, &entry.name, DIR_LINK),
                    EntryKind::Symlink {
                        target_kind: None, ..
                    } => self.skip(key, &entry.path, &dst_dir, &entry.name, BROKEN_LINK),
                    EntryKind::Other => self.skip(key, &entry.path, &dst_dir, &entry.name, SPECIAL),
                }
            }
            self.announce(false);
        }
        if self.token.is_cancelled() {
            return Err(Vec::new());
        }
        Ok(())
    }

    /// Make the destination folders, one level at a time (a folder's parent
    /// is always made first), several at once. Returns the folders that
    /// could not be made (they became failed placeholders); `Err` when the
    /// connection went or the batch was cancelled.
    async fn make_dirs(&mut self) -> Result<HashSet<String>, ()> {
        let mut dirs = std::mem::take(&mut self.inv.dirs);
        dirs.sort_by(|a, b| (a.level, &a.key).cmp(&(b.level, &b.key)));
        let limit = self.dst.walk_limit();
        let mut failed: HashSet<String> = HashSet::new();
        let mut result = Ok(());
        let mut start = 0;
        while start < dirs.len() && result.is_ok() {
            let level = dirs[start].level;
            let end = start
                + dirs[start..]
                    .iter()
                    .take_while(|d| d.level == level)
                    .count();
            let mut running = JoinSet::new();
            let mut next = start;
            while (next < end || !running.is_empty()) && result.is_ok() {
                while next < end && running.len() < limit {
                    let dir = &dirs[next];
                    // Below a folder that could not be made: covered by
                    // that folder's placeholder.
                    if failed.contains(&dir.dst_parent) {
                        failed.insert(dir.dst.clone());
                        next += 1;
                        continue;
                    }
                    let dst = self.dst.clone();
                    let path = dir.dst.clone();
                    let top = dir.level == 0;
                    let index = next;
                    running.spawn(async move {
                        let made = if top {
                            dst.mkdir_all(&path).await
                        } else {
                            dst.mkdir_one(&path).await
                        };
                        (index, made)
                    });
                    next += 1;
                }
                let joined = tokio::select! {
                    joined = running.join_next() => joined,
                    () = self.token.cancelled() => {
                        result = Err(());
                        break;
                    }
                };
                let Some(Ok((index, made))) = joined else {
                    continue;
                };
                if let Err(e) = made {
                    if self.lost(&e).await {
                        result = Err(());
                        break;
                    }
                    let dir = dirs[index].clone();
                    failed.insert(dir.dst.clone());
                    self.fail_folder(
                        &FolderTag {
                            key: dir.key,
                            level: dir.level,
                            dst_parent: dir.dst_parent,
                            name: dir.name,
                        },
                        &dir.src,
                        &e,
                    );
                }
            }
            start = end;
        }
        if result.is_err() {
            // Kept for the resume: making a folder twice is fine.
            self.inv.dirs = dirs;
            return Err(());
        }
        Ok(failed)
    }

    /// The jobs to add, in path order; those inside folders that could not
    /// be made are left out (retrying the folder brings them back).
    fn jobs(&mut self, failed: HashSet<String>) -> Vec<NewJob> {
        let mut jobs = std::mem::take(&mut self.inv.jobs);
        jobs.sort_by(|a, b| a.0.cmp(&b.0));
        jobs.into_iter()
            .filter(|(_, job)| job.walk.is_some() || !failed.contains(&job.dst_dir))
            .map(|(_, job)| job)
            .collect()
    }

    /// Report the counts (throttled, unless `now`).
    fn announce(&mut self, now: bool) {
        let ready = self.throttle.ready(Instant::now()) || now;
        self.shared.counted(
            self.batch_id,
            self.inv.files,
            self.inv.bytes,
            self.inv.folders,
            ready,
        );
    }

    fn file(
        &mut self,
        key: Key,
        src: &str,
        dst_dir: &str,
        name: &str,
        size: u64,
        resolution: Option<ConflictResolution>,
    ) {
        self.inv.files += 1;
        self.inv.bytes += size;
        let state = TransferState::Queued;
        self.add(key, src, dst_dir, name, size, state, None, None, resolution);
    }

    fn skip(&mut self, key: Key, src: &str, dst_dir: &str, name: &str, why: &str) {
        let error = TransferError {
            kind: "invalidInput".into(),
            message: format!("{src}: {why}"),
        };
        let state = TransferState::Skipped;
        self.add(key, src, dst_dir, name, 0, state, Some(error), None, None);
    }

    /// A `failed` placeholder for a folder that could not be listed or
    /// made: retrying it walks `src` again.
    fn fail_folder(&mut self, tag: &FolderTag, src: &str, err: &CoreError) {
        tracing::info!(kind = err.kind(), "could not count a transfer folder");
        let error = Some(TransferError::from(err));
        let state = TransferState::Failed;
        let walk = Some(Walk::Folder);
        let (key, parent, name) = (tag.key.clone(), &tag.dst_parent, &tag.name);
        self.add(key, src, parent, name, 0, state, error, walk, None);
    }

    #[allow(clippy::too_many_arguments)] // one job's fields, passed through
    fn add(
        &mut self,
        key: Key,
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
        self.inv.jobs.push((
            key,
            NewJob {
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
            },
        ));
    }
}

/// Look at one selected item (a link reported, and for a link to a file
/// the file it points to).
async fn look(side: &Side, path: &str) -> Looked {
    let entry = side.entry(path).await;
    let target = match &entry {
        Ok(Entry {
            kind:
                EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::File),
                    ..
                },
            ..
        }) => match side.metadata(path).await {
            Ok(meta) => meta,
            Err(e) => {
                return Looked {
                    entry: Err(e),
                    target: None,
                }
            }
        },
        _ => None,
    };
    Looked { entry, target }
}
