//! Walking folder trees with several listings in flight at once.
//!
//! Over SFTP a folder listing is several round trips (OPENDIR, READDIR
//! until EOF, CLOSE, plus a STAT per link), so a tree listed one folder at
//! a time costs folders × round trips × latency. [`FolderWalk`] keeps up to
//! a limit of listings running and hands them back as they finish; the
//! caller decides what to do with each folder's entries and which
//! subfolders to walk into. Sync comparisons, transfer expansion and drag
//! out preparation all walk through it, each keeping its own rules (safe
//! names, links, excludes, placeholders).
//!
//! ## Shape
//! - **Pull-based**: `next()` returns the next finished listing; the
//!   caller can await other things (create a folder, ping the server)
//!   between calls. Listings run as spawned tasks, so they keep going
//!   meanwhile.
//! - **Several channels**: a remote walk spreads its listings over a few
//!   SFTP channels ([`REMOTE_WALK_CHANNELS`]), each also pipelining its
//!   requests. One channel is served by one server process that handles
//!   its requests in turn, so several channels also overlap the server's
//!   own disk work.
//! - **Order**: listings finish in any order. Callers sort what they
//!   collect, so plans, job lists and tests stay deterministic.
//! - **Stopping**: dropping the walk aborts the listings in flight;
//!   [`FolderWalk::into_pending`] hands back every folder that was not
//!   returned yet (for the transfer engine's paused placeholders).

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::Arc;

use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::error::CoreResult;
use crate::fs::{Entry, EntryKind, FileMeta, LinkTargetKind, SftpFs};
use crate::session_manager::LiveSession;
use crate::transfer::side::Side;

/// Remote folder listings in flight at once (over all channels).
pub const REMOTE_LISTINGS: usize = 16;
/// Local folder listings in flight at once (blocking-pool threads).
pub const LOCAL_LISTINGS: usize = 32;
/// SFTP channels a remote walk spreads its listings over. More channels
/// than this gain little (each one pipelines too) and every channel is a
/// session on the server, which OpenSSH limits (`MaxSessions`, 10).
pub const REMOTE_WALK_CHANNELS: usize = 4;

/// One entry of a listed folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WalkEntry {
    pub entry: Entry,
    /// For a link to a file: the file it points to (its size, date and
    /// mode). `None` for anything else, and for a link to a file that
    /// could not be looked at (treated as broken).
    pub target: Option<FileMeta>,
}

/// Something folders can be listed from: a [`Side`] (the local disk or an
/// SFTP channel), or a fake in tests.
pub(crate) trait ListFolder: Clone + Send + Sync + 'static {
    /// The entries of the folder `path`, links to files followed (their
    /// [`WalkEntry::target`]). An error that means the connection is gone
    /// fails the whole listing, so the caller can tell.
    fn list_folder(&self, path: &str) -> impl Future<Output = CoreResult<Vec<WalkEntry>>> + Send;
}

impl ListFolder for Side {
    async fn list_folder(&self, path: &str) -> CoreResult<Vec<WalkEntry>> {
        let entries = self.list(path).await?;
        // The links' targets are looked at concurrently (pipelined on the
        // channel); plain entries already carry everything.
        let mut links = JoinSet::new();
        for (index, entry) in entries.iter().enumerate() {
            if matches!(
                entry.kind,
                EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::File),
                    ..
                }
            ) {
                let side = self.clone();
                let path = entry.path.clone();
                links.spawn(async move { (index, side.metadata(&path).await) });
            }
        }
        let mut out: Vec<WalkEntry> = entries
            .into_iter()
            .map(|entry| WalkEntry {
                entry,
                target: None,
            })
            .collect();
        while let Some(joined) = links.join_next().await {
            let Ok((index, meta)) = joined else { continue };
            match meta {
                Ok(meta) => out[index].target = meta,
                Err(e) if is_connection(&e) => return Err(e),
                // Unreadable: the link counts as broken.
                Err(_) => {}
            }
        }
        Ok(out)
    }
}

/// The SFTP channels a remote walk lists from: the session's own
/// and up to [`REMOTE_WALK_CHANNELS`] − 1 more opened on its connection.
/// A channel that cannot be opened (the server's session limit, say) is
/// simply left out. Hand the extra ones to [`close_channels`] afterwards.
pub(crate) async fn open_walk_channels(live: &Arc<LiveSession>) -> (Vec<Side>, Vec<SftpFs>) {
    let mut opening = JoinSet::new();
    for _ in 1..REMOTE_WALK_CHANNELS {
        let live = Arc::clone(live);
        opening.spawn(async move { live.ssh.open_sftp_channel().await });
    }
    let mut extra = Vec::new();
    while let Some(opened) = opening.join_next().await {
        match opened {
            Ok(Ok(channel)) => extra.push(channel),
            Ok(Err(e)) => tracing::debug!(kind = e.kind(), "no extra channel for a walk"),
            Err(_) => {}
        }
    }
    let sides = std::iter::once(live.ssh.fs().clone())
        .chain(extra.iter().cloned())
        .map(Side::Remote)
        .collect();
    (sides, extra)
}

/// Close the extra channels of [`open_walk_channels`], in the background.
pub(crate) fn close_channels(channels: Vec<SftpFs>) {
    if channels.is_empty() {
        return;
    }
    tokio::spawn(async move {
        for channel in channels {
            channel.close().await;
        }
    });
}

/// The connection is gone (or not answering): a walk cannot go on.
pub(crate) fn is_connection(err: &crate::CoreError) -> bool {
    matches!(
        err,
        crate::CoreError::NotConnected | crate::CoreError::NoAnswer
    )
}

/// A listed folder, as [`FolderWalk::next`] hands it back.
pub(crate) struct Listing<T> {
    /// The folder's path.
    pub path: String,
    /// What the caller pushed with it.
    pub tag: T,
    pub entries: CoreResult<Vec<WalkEntry>>,
}

/// A queue of folders to list, with up to a limit of listings running at
/// once (see the module docs).
pub(crate) struct FolderWalk<L: ListFolder, T> {
    listers: Vec<L>,
    /// Listings running per lister, to pick the least busy one.
    busy: Vec<usize>,
    limit: usize,
    queue: VecDeque<(String, T)>,
    running: JoinSet<CoreResult<Vec<WalkEntry>>>,
    /// Running listings by task: (order started, path, tag, lister index).
    in_flight: HashMap<tokio::task::Id, (u64, String, T, usize)>,
    next_key: u64,
    token: Option<CancellationToken>,
    max_seen: usize,
}

impl<L: ListFolder, T> FolderWalk<L, T> {
    /// A walk listing from `listers` (at least one), at most `limit`
    /// listings at once.
    pub fn new(listers: Vec<L>, limit: usize) -> Self {
        assert!(!listers.is_empty(), "a walk needs something to list from");
        let busy = vec![0; listers.len()];
        Self {
            listers,
            busy,
            limit: limit.max(1),
            queue: VecDeque::new(),
            running: JoinSet::new(),
            in_flight: HashMap::new(),
            next_key: 0,
            token: None,
            max_seen: 0,
        }
    }

    /// Stop handing out listings once `token` is cancelled.
    pub fn with_cancel(mut self, token: CancellationToken) -> Self {
        self.token = Some(token);
        self
    }

    /// Queue the folder `path`.
    pub fn push(&mut self, path: String, tag: T) {
        self.queue.push_back((path, tag));
    }

    /// The most listings that ran at once.
    #[cfg(test)]
    pub fn max_in_flight(&self) -> usize {
        self.max_seen
    }

    fn start_more(&mut self) {
        while self.in_flight.len() < self.limit {
            let Some((path, tag)) = self.queue.pop_front() else {
                break;
            };
            let (index, _) = self
                .busy
                .iter()
                .enumerate()
                .min_by_key(|(_, n)| **n)
                .expect("at least one lister");
            self.busy[index] += 1;
            let key = self.next_key;
            self.next_key += 1;
            let lister = self.listers[index].clone();
            let at = path.clone();
            let task = self
                .running
                .spawn(async move { lister.list_folder(&at).await });
            self.in_flight.insert(task.id(), (key, path, tag, index));
        }
        self.max_seen = self.max_seen.max(self.in_flight.len());
    }

    /// The next listed folder, in the order they finish; `None` when
    /// nothing is left (or the walk was cancelled: check the token).
    pub async fn next(&mut self) -> Option<Listing<T>> {
        loop {
            if self.token.as_ref().is_some_and(|t| t.is_cancelled()) {
                self.running.abort_all();
                return None;
            }
            self.start_more();
            if self.in_flight.is_empty() {
                return None;
            }
            let joined = match &self.token {
                Some(token) => tokio::select! {
                    joined = self.running.join_next_with_id() => joined,
                    () = token.cancelled() => continue,
                },
                None => self.running.join_next_with_id().await,
            };
            let (id, entries) = match joined? {
                Ok(done) => done,
                // A listing task that panicked: the folder counts as one
                // that could not be read, rather than being lost.
                Err(e) => {
                    tracing::warn!("a folder listing task failed: {e}");
                    let failed = std::io::Error::other("the folder could not be listed");
                    (e.id(), Err(crate::CoreError::Io(failed)))
                }
            };
            let Some((_, path, tag, index)) = self.in_flight.remove(&id) else {
                continue;
            };
            self.busy[index] = self.busy[index].saturating_sub(1);
            return Some(Listing { path, tag, entries });
        }
    }

    /// Stop: every folder not handed out yet (being listed or queued),
    /// listings in flight first, in the order they were pushed.
    pub fn into_pending(mut self) -> Vec<(String, T)> {
        self.running.abort_all();
        let mut in_flight: Vec<(u64, String, T, usize)> =
            self.in_flight.drain().map(|(_, v)| v).collect();
        in_flight.sort_by_key(|(key, ..)| *key);
        in_flight
            .into_iter()
            .map(|(_, path, tag, _)| (path, tag))
            .chain(self.queue)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;
    use crate::CoreError;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// A fake tree: `dir/` paths map to their child names (`name/` for a
    /// folder). Counts listings in flight; some paths fail.
    #[derive(Clone, Default)]
    struct Fake {
        tree: Arc<HashMap<String, Vec<String>>>,
        failing: Arc<HashSet<String>>,
        now: Arc<AtomicUsize>,
        max: Arc<AtomicUsize>,
        listed: Arc<Mutex<Vec<String>>>,
    }

    impl Fake {
        /// `width` folders per folder, `depth` levels, one file each.
        fn tree(width: usize, depth: usize) -> Self {
            let mut tree = HashMap::new();
            fn fill(
                tree: &mut HashMap<String, Vec<String>>,
                path: &str,
                width: usize,
                depth: usize,
            ) {
                let mut children = vec!["file.txt".to_string()];
                if depth > 0 {
                    for i in 0..width {
                        let child = format!("{path}/d{i}");
                        children.push(format!("d{i}/"));
                        fill(tree, &child, width, depth - 1);
                    }
                }
                tree.insert(path.to_string(), children);
            }
            fill(&mut tree, "/r", width, depth);
            Self {
                tree: Arc::new(tree),
                ..Self::default()
            }
        }
    }

    impl ListFolder for Fake {
        async fn list_folder(&self, path: &str) -> CoreResult<Vec<WalkEntry>> {
            let now = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.max.fetch_max(now, Ordering::SeqCst);
            // Later folders finish first now and then: the order varies.
            let jitter = (path.len() * 7 + path.bytes().map(usize::from).sum::<usize>()) % 5;
            tokio::time::sleep(Duration::from_millis(1 + jitter as u64)).await;
            self.now.fetch_sub(1, Ordering::SeqCst);
            self.listed.lock().unwrap().push(path.to_string());
            if self.failing.contains(path) {
                return Err(CoreError::PermissionDenied(path.to_string()));
            }
            let children = self.tree.get(path).cloned().unwrap_or_default();
            Ok(children
                .into_iter()
                .map(|child| {
                    let (name, kind) = match child.strip_suffix('/') {
                        Some(dir) => (dir.to_string(), EntryKind::Dir),
                        None => (child, EntryKind::File),
                    };
                    WalkEntry {
                        entry: Entry {
                            path: format!("{path}/{name}"),
                            name,
                            kind,
                            size: 1,
                            mtime: None,
                            mode: None,
                            hidden: false,
                        },
                        target: None,
                    }
                })
                .collect())
        }
    }

    /// Walk everything under `/r`; returns every path found, sorted, and
    /// the folders that failed.
    async fn walk_all(fake: Fake, limit: usize) -> (Vec<String>, Vec<String>, usize) {
        let mut walk = FolderWalk::new(vec![fake.clone(), fake], limit);
        walk.push("/r".into(), ());
        let mut found = Vec::new();
        let mut failed = Vec::new();
        while let Some(listing) = walk.next().await {
            match listing.entries {
                Ok(entries) => {
                    for e in entries {
                        if e.entry.kind == EntryKind::Dir {
                            walk.push(e.entry.path.clone(), ());
                        }
                        found.push(e.entry.path);
                    }
                }
                Err(_) => failed.push(listing.path),
            }
        }
        found.sort();
        (found, failed, walk.max_in_flight())
    }

    #[tokio::test]
    async fn never_more_listings_than_the_limit() {
        let fake = Fake::tree(4, 3);
        let (found, _, max_seen) = walk_all(fake.clone(), 6).await;
        // 4 + 16 + 64 folders, a file in each and in the root.
        assert_eq!(found.len(), 84 + 85);
        let max = fake.max.load(Ordering::SeqCst);
        assert!(max <= 6, "{max}");
        assert!(max > 1, "listings overlapped: {max}");
        assert_eq!(max_seen, 6);
    }

    #[tokio::test]
    async fn the_result_is_the_same_every_time() {
        let (first, _, _) = walk_all(Fake::tree(3, 3), 8).await;
        for limit in [1, 2, 16] {
            let (again, _, _) = walk_all(Fake::tree(3, 3), limit).await;
            assert_eq!(again, first, "limit {limit}");
        }
    }

    #[tokio::test]
    async fn a_failing_folder_is_reported_and_the_rest_is_walked() {
        let mut fake = Fake::tree(2, 2);
        fake.failing = Arc::new(["/r/d0".to_string()].into());
        let (found, failed, _) = walk_all(fake, 4).await;
        assert_eq!(failed, vec!["/r/d0"]);
        assert!(found.iter().all(|p| !p.starts_with("/r/d0/")), "{found:?}");
        assert!(found.contains(&"/r/d1/d1/file.txt".to_string()));
    }

    #[tokio::test]
    async fn cancelling_stops_the_walk_and_pending_folders_are_handed_back() {
        let fake = Fake::tree(4, 3);
        let token = CancellationToken::new();
        let mut walk = FolderWalk::new(vec![fake.clone()], 4).with_cancel(token.clone());
        walk.push("/r".into(), 0usize);
        let mut handed = 0;
        while let Some(listing) = walk.next().await {
            handed += 1;
            for e in listing.entries.unwrap() {
                if e.entry.kind == EntryKind::Dir {
                    walk.push(e.entry.path, handed);
                }
            }
            if handed == 3 {
                token.cancel();
            }
        }
        assert_eq!(handed, 3, "nothing after the cancel");
        let pending = walk.into_pending();
        assert!(!pending.is_empty());
        // Nothing handed out is pending; nothing pending was listed twice.
        let listed = fake.listed.lock().unwrap().len();
        assert!(listed < 85, "the walk stopped early: {listed}");
    }

    #[tokio::test]
    async fn a_local_walk_follows_links_to_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("real.txt"), "12345").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link")).unwrap();
        let side = Side::Local(LocalFs::new());
        let entries = side.list_folder(&root.to_string_lossy()).await.unwrap();
        let real = entries.iter().find(|e| e.entry.name == "real.txt").unwrap();
        assert!(real.target.is_none());
        #[cfg(unix)]
        {
            let link = entries.iter().find(|e| e.entry.name == "link").unwrap();
            let target = link.target.unwrap();
            assert!(!target.is_dir);
            assert_eq!(target.size, 5);
        }
    }
}
