//! Walking one side of a sync into the flat list [`super::diff::diff`]
//! compares. The transfer engine's rules apply: names must be one plain
//! segment, a link to a file counts as that file (its size and date), and
//! folder links, broken links and sockets/devices are not followed but
//! listed as unsupported, with the reason.
//!
//! For a sync limited to recently changed files ("Only files changed in")
//! the walk keeps only what changed (see [`walk`]), and the target is not
//! walked at all: [`stat_candidates`] looks up just the paths found.

use std::collections::{BTreeMap, HashSet};

use tokio::task::JoinSet;

use crate::error::{CoreError, CoreResult};
use crate::fs::walk::{is_connection, FolderWalk, ListFolder};
use crate::fs::{Entry, EntryKind, FileMeta, LinkTargetKind};
use crate::transfer::naming::is_safe_name;
use crate::transfer::side::Side;
use crate::transfer::{BROKEN_LINK, DIR_LINK, SPECIAL, UNSAFE_NAME};

use super::diff::{Listed, Node};

/// Why a folder's contents are left alone: it could not be listed.
pub(crate) const UNREADABLE_FOLDER: &str = "the folder could not be read";
/// Why an item is left alone: it could not be looked at.
pub(crate) const UNREADABLE_ITEM: &str = "it could not be read";

/// Counts a walk reports as it goes: `folder(files)` per folder listed,
/// with the number of files in it; `checked(n)` per `n` paths looked up.
pub(crate) trait WalkProgress: Sync {
    fn folder(&self, files: u64);
    fn checked(&self, _paths: u64) {}
}

/// No progress wanted.
pub(crate) struct Quiet;

impl WalkProgress for Quiet {
    fn folder(&self, _files: u64) {}
}

/// What an entry is for the comparison (`target`: the file a link to a
/// file points to, if it could be looked at).
pub(crate) fn node_of(entry: &Entry, target: Option<FileMeta>) -> Node {
    let unsupported = |why: &str| Node::Unsupported(why.to_string());
    if !is_safe_name(&entry.name) {
        return unsupported(UNSAFE_NAME);
    }
    match entry.kind {
        EntryKind::File => Node::File {
            size: entry.size,
            mtime: entry.mtime,
        },
        EntryKind::Dir => Node::Dir,
        EntryKind::Symlink {
            target_kind: Some(LinkTargetKind::File),
            ..
        } => match target {
            Some(meta) if !meta.is_dir => Node::File {
                size: meta.size,
                mtime: meta.mtime,
            },
            _ => unsupported(BROKEN_LINK),
        },
        EntryKind::Symlink {
            target_kind: Some(LinkTargetKind::Dir),
            ..
        } => unsupported(DIR_LINK),
        EntryKind::Symlink {
            target_kind: None, ..
        } => unsupported(BROKEN_LINK),
        EntryKind::Other => unsupported(SPECIAL),
    }
}

/// A date within a window starting at `since`. An unknown date counts as
/// within: only the comparison can tell then.
pub(crate) fn in_window(mtime: Option<i64>, since: i64) -> bool {
    mtime.is_none_or(|m| m >= since)
}

/// Every entry below the folder `root`, in path order (a folder before its
/// contents). Folders for which `prune(name, hidden)` holds are listed but
/// not walked into (excluded or hidden ones: their contents are never
/// touched anyway). Up to `limit` folders are listed at once, spread over
/// `listers` (several SFTP channels of one session, or the local disk).
///
/// A subfolder that cannot be listed (permission denied, …) becomes
/// unsupported, so nothing under it is copied or deleted; the root failing,
/// or the connection going, fails the walk.
///
/// With `changed_since` only what changed is kept, exactly as the server
/// search (`remote_find.rs`) finds it: files (a link to a file by its
/// target) modified at or after it; folder links, broken links and
/// sockets/devices whose own date is; unreadable folders, and folders with
/// an unsafe name (they cannot be looked into). Pruned names are dropped
/// entirely, and so are the folders themselves (the caller adds the ones
/// it needs with [`with_parents`]).
pub(crate) async fn walk<L: ListFolder>(
    listers: Vec<L>,
    limit: usize,
    root: &str,
    prune: &(dyn Fn(&str, bool) -> bool + Sync),
    changed_since: Option<i64>,
    progress: &dyn WalkProgress,
) -> CoreResult<Vec<Listed>> {
    let mut out: Vec<Listed> = Vec::new();
    // Each folder carries its segments and its index in `out` (`None` for
    // the root).
    let mut folders: FolderWalk<L, (Vec<String>, Option<usize>)> = FolderWalk::new(listers, limit);
    folders.push(root.to_string(), (Vec::new(), None));
    while let Some(listing) = folders.next().await {
        let (segments, index) = listing.tag;
        let entries = match listing.entries {
            Ok(entries) => entries,
            Err(e) if index.is_none() || is_connection(&e) => return Err(e),
            Err(e) => {
                tracing::info!(kind = e.kind(), "a sync could not list a folder");
                if let Some(i) = index {
                    out[i].node = Node::Unsupported(UNREADABLE_FOLDER.into());
                }
                continue;
            }
        };
        let mut files = 0;
        for walked in entries {
            let entry = &walked.entry;
            let pruned = prune(&entry.name, entry.hidden);
            if changed_since.is_some() && pruned {
                continue;
            }
            let node = node_of(entry, walked.target);
            if let Some(since) = changed_since {
                let keep = match &node {
                    Node::Dir => true,
                    Node::File { mtime, .. } => in_window(*mtime, since),
                    Node::Unsupported(_) if entry.kind == EntryKind::Dir => true,
                    Node::Unsupported(_) => in_window(entry.mtime, since),
                };
                if !keep {
                    continue;
                }
            }
            let mut path = segments.clone();
            path.push(entry.name.clone());
            if matches!(node, Node::File { .. }) {
                files += 1;
            }
            if node == Node::Dir && !pruned {
                folders.push(entry.path.clone(), (path.clone(), Some(out.len())));
            }
            out.push(Listed {
                segments: path,
                node,
                hidden: entry.hidden,
            });
        }
        progress.folder(files);
    }
    if changed_since.is_some() {
        out.retain(|l| l.node != Node::Dir);
    }
    // Listings finish in any order: sort for a stable result.
    out.sort_by(|a, b| a.segments.cmp(&b.segments));
    Ok(out)
}

/// `found` plus a folder entry for every folder they are in, in path order
/// (so the comparison sees the folders a copy needs, and a file in the
/// target's place blocks what is under it).
pub(crate) fn with_parents(found: Vec<Listed>) -> Vec<Listed> {
    let mut all: BTreeMap<Vec<String>, Listed> = BTreeMap::new();
    for listed in found {
        for n in 1..listed.segments.len() {
            let parent = listed.segments[..n].to_vec();
            all.entry(parent.clone()).or_insert_with(|| Listed {
                segments: parent,
                node: Node::Dir,
                hidden: false,
            });
        }
        all.insert(listed.segments.clone(), listed);
    }
    all.into_values().collect()
}

/// What the target has at the paths of `source` (a changed-files search
/// with its folders), below `root`, looked up `limit` at a time over
/// `listers` — never a listing. Level by level: nothing under a folder the
/// target lacks (or has as something else) is looked up, since the
/// comparison makes those `new` (or blocks them) anyway. Unsupported
/// source items are not looked up (they are skipped whatever is there).
/// The connection going fails the lookup; any other failure makes that
/// item unsupported on the target.
pub(crate) async fn stat_candidates(
    listers: Vec<Side>,
    limit: usize,
    root: &str,
    source: &[Listed],
    progress: &dyn WalkProgress,
) -> CoreResult<Vec<Listed>> {
    let joiner = listers.first().cloned().ok_or_else(|| {
        CoreError::InvalidInput("there is nothing to look the items up on".into())
    })?;
    let depth = source.iter().map(|l| l.segments.len()).max().unwrap_or(0);
    let mut folders: HashSet<Vec<String>> = HashSet::from([Vec::new()]);
    let mut out = Vec::new();
    for level in 1..=depth {
        let wanted: Vec<&Listed> = source
            .iter()
            .filter(|l| {
                l.segments.len() == level
                    && !matches!(l.node, Node::Unsupported(_))
                    && folders.contains(&l.segments[..level - 1])
            })
            .collect();
        let paths: Vec<(Vec<String>, String)> = wanted
            .iter()
            .map(|l| {
                let path = l
                    .segments
                    .iter()
                    .fold(root.to_string(), |path, name| joiner.join(&path, name));
                (l.segments.clone(), path)
            })
            .collect();
        for (segments, found) in look_up(&listers, limit, paths, progress).await? {
            let Some((node, hidden)) = found else {
                continue;
            };
            if node == Node::Dir {
                folders.insert(segments.clone());
            }
            out.push(Listed {
                segments,
                node,
                hidden,
            });
        }
    }
    out.sort_by(|a, b| a.segments.cmp(&b.segments));
    Ok(out)
}

/// Look up each of `paths` (`(segments, full path)`), `limit` at a time,
/// spread over `listers`; `None` for nothing there.
#[allow(clippy::type_complexity)]
async fn look_up(
    listers: &[Side],
    limit: usize,
    paths: Vec<(Vec<String>, String)>,
    progress: &dyn WalkProgress,
) -> CoreResult<Vec<(Vec<String>, Option<(Node, bool)>)>> {
    let mut queue = paths.into_iter().enumerate();
    let mut running = JoinSet::new();
    let mut out = Vec::new();
    loop {
        while running.len() < limit.max(1) {
            let Some((index, (segments, path))) = queue.next() else {
                break;
            };
            let side = listers[index % listers.len()].clone();
            running.spawn(async move { (segments, look_up_one(&side, &path).await) });
        }
        let Some(joined) = running.join_next().await else {
            break;
        };
        let (segments, found) = match joined {
            Ok(done) => done,
            Err(e) => {
                tracing::warn!("a lookup task failed: {e}");
                continue;
            }
        };
        progress.checked(1);
        out.push((segments, found?));
    }
    Ok(out)
}

async fn look_up_one(side: &Side, path: &str) -> CoreResult<Option<(Node, bool)>> {
    let entry = match side.entry(path).await {
        Ok(entry) => entry,
        Err(CoreError::NotFound(_)) => return Ok(None),
        Err(e) if is_connection(&e) => return Err(e),
        Err(e) => {
            tracing::debug!(kind = e.kind(), "a sync could not look an item up");
            return Ok(Some((Node::Unsupported(UNREADABLE_ITEM.into()), false)));
        }
    };
    let target = match entry.kind {
        EntryKind::Symlink {
            target_kind: Some(LinkTargetKind::File),
            ..
        } => match side.metadata(path).await {
            Ok(meta) => meta,
            Err(e) if is_connection(&e) => return Err(e),
            Err(_) => None,
        },
        _ => None,
    };
    Ok(Some((node_of(&entry, target), entry.hidden)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;
    use crate::transfer::side::Side;

    fn local() -> Vec<Side> {
        vec![Side::Local(LocalFs::new())]
    }

    fn s(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn walks_in_path_order_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/c.txt"), "abc").unwrap();
        std::fs::write(root.join("z.txt"), "z").unwrap();
        std::fs::create_dir_all(root.join("skip/deep")).unwrap();
        let listed = walk(
            local(),
            4,
            &s(root),
            &|name, _| name == "skip",
            None,
            &Quiet,
        )
        .await
        .unwrap();
        let paths: Vec<String> = listed.iter().map(|l| l.segments.join("/")).collect();
        assert_eq!(paths, vec!["a", "a/b", "a/b/c.txt", "skip", "z.txt"]);
        let c = listed.iter().find(|l| l.segments.len() == 3).unwrap();
        assert!(matches!(c.node, Node::File { size: 3, .. }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn links_follow_the_transfer_rules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("real.txt"), "12345").unwrap();
        std::fs::create_dir(root.join("folder")).unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("to-file")).unwrap();
        std::os::unix::fs::symlink(root.join("folder"), root.join("to-folder")).unwrap();
        std::os::unix::fs::symlink(root.join("missing"), root.join("broken")).unwrap();
        let listed = walk(local(), 4, &s(root), &|_, _| false, None, &Quiet)
            .await
            .unwrap();
        let node = |name: &str| {
            listed
                .iter()
                .find(|l| l.segments == [name])
                .map(|l| l.node.clone())
                .unwrap()
        };
        assert!(matches!(node("to-file"), Node::File { size: 5, .. }));
        assert_eq!(node("to-folder"), Node::Unsupported(DIR_LINK.into()));
        assert_eq!(node("broken"), Node::Unsupported(BROKEN_LINK.into()));
    }

    fn touch(path: &std::path::Path, secs: u64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        if !path.exists() {
            std::fs::write(path, "x").unwrap();
        }
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
            .unwrap();
    }

    const T: u64 = 1_700_000_000;

    #[tokio::test]
    async fn a_windowed_walk_keeps_only_what_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("new.txt"), T);
        touch(&root.join("old.txt"), T - 1);
        touch(&root.join("deep/er/new.txt"), T + 50);
        touch(&root.join("deep/old.txt"), T - 100);
        touch(&root.join("app.log"), T + 5);
        touch(&root.join("skip/new.txt"), T + 5);
        let prune = |name: &str, _: bool| name == "skip" || name.ends_with(".log");
        let listed = walk(local(), 4, &s(root), &prune, Some(T as i64), &Quiet)
            .await
            .unwrap();
        let paths: Vec<String> = listed.iter().map(|l| l.segments.join("/")).collect();
        // No folders, nothing old, nothing pruned (not even listed).
        assert_eq!(paths, vec!["deep/er/new.txt", "new.txt"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_windowed_walk_reports_links_by_their_own_or_their_targets_date() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("real-old.txt"), T - 10);
        touch(&root.join("real-new.txt"), T + 10);
        std::fs::create_dir(root.join("folder")).unwrap();
        std::os::unix::fs::symlink(root.join("real-old.txt"), root.join("to-old")).unwrap();
        std::os::unix::fs::symlink(root.join("real-new.txt"), root.join("to-new")).unwrap();
        // Links made now: their own date is in the window.
        std::os::unix::fs::symlink(root.join("folder"), root.join("to-folder")).unwrap();
        std::os::unix::fs::symlink(root.join("missing"), root.join("broken")).unwrap();
        let listed = walk(local(), 4, &s(root), &|_, _| false, Some(T as i64), &Quiet)
            .await
            .unwrap();
        let names: Vec<(String, Node)> = listed
            .iter()
            .map(|l| (l.segments.join("/"), l.node.clone()))
            .collect();
        assert_eq!(
            names.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            vec!["broken", "real-new.txt", "to-folder", "to-new"]
        );
        assert_eq!(names[0].1, Node::Unsupported(BROKEN_LINK.into()));
        assert_eq!(names[2].1, Node::Unsupported(DIR_LINK.into()));
    }

    fn file(path: &str, size: u64) -> Listed {
        Listed {
            segments: path.split('/').map(String::from).collect(),
            node: Node::File {
                size,
                mtime: Some(T as i64),
            },
            hidden: false,
        }
    }

    #[test]
    fn parents_are_added_once_in_path_order() {
        let all = with_parents(vec![file("a/b/c.txt", 1), file("a/d.txt", 2), file("z", 3)]);
        let paths: Vec<(String, bool)> = all
            .iter()
            .map(|l| (l.segments.join("/"), l.node == Node::Dir))
            .collect();
        assert_eq!(
            paths,
            vec![
                ("a".into(), true),
                ("a/b".into(), true),
                ("a/b/c.txt".into(), false),
                ("a/d.txt".into(), false),
                ("z".into(), false),
            ]
        );
    }

    #[derive(Default)]
    struct Count(std::sync::atomic::AtomicU64);

    impl WalkProgress for Count {
        fn folder(&self, _files: u64) {}
        fn checked(&self, paths: u64) {
            self.0
                .fetch_add(paths, std::sync::atomic::Ordering::Relaxed);
        }
    }

    #[tokio::test]
    async fn only_candidates_under_existing_folders_are_looked_up() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        touch(&root.join("a/b/c.txt"), T);
        touch(&root.join("a/d.txt"), T);
        // A file where the source has a folder.
        touch(&root.join("clash"), T);
        let source = with_parents(vec![
            file("a/b/c.txt", 1),
            file("a/d.txt", 1),
            file("a/missing/e.txt", 1),
            file("gone/deeper/f.txt", 1),
            file("clash/g.txt", 1),
            Listed {
                node: Node::Unsupported(BROKEN_LINK.into()),
                ..file("a/link", 0)
            },
        ]);
        let count = Count::default();
        let target = stat_candidates(local(), 4, &s(root), &source, &count)
            .await
            .unwrap();
        let paths: Vec<(String, Node)> = target
            .iter()
            .map(|l| (l.segments.join("/"), l.node.clone()))
            .collect();
        assert_eq!(paths.len(), 5, "{paths:?}");
        assert_eq!(paths[0], ("a".into(), Node::Dir));
        assert_eq!(paths[1], ("a/b".into(), Node::Dir));
        assert!(matches!(&paths[2], (p, Node::File { size: 1, .. }) if p == "a/b/c.txt"));
        assert_eq!(paths[3].0, "a/d.txt");
        assert!(matches!(&paths[4], (p, Node::File { .. }) if p == "clash"));
        // a, clash, gone; a/b, a/d.txt, a/missing; a/b/c.txt. Nothing
        // under the missing or clashing folders, nor the link.
        assert_eq!(count.0.load(std::sync::atomic::Ordering::Relaxed), 7);

        // The comparison: what is missing is new, the clash blocks.
        let rules = super::super::diff::DiffRules {
            mode: crate::sync::SyncMode::Update,
            rule: crate::sync::CompareRule::SizeOrDate,
            protect_newer: true,
            skip_hidden: false,
            max_file_size_mb: None,
            excludes: Vec::new(),
        };
        let found = super::super::diff::diff(&source, &target, &rules);
        let groups: Vec<(String, crate::sync::SyncGroup)> = found
            .items
            .iter()
            .map(|i| (i.path.clone(), i.group))
            .collect();
        use crate::sync::SyncGroup::*;
        assert_eq!(
            groups,
            vec![
                ("a/link".into(), Skipped),
                ("a/missing".into(), New),
                ("a/missing/e.txt".into(), New),
                ("clash".into(), TypeMismatch),
                ("gone".into(), New),
                ("gone/deeper".into(), New),
                ("gone/deeper/f.txt".into(), New),
            ]
        );
        // c.txt and d.txt have the same size and date: identical.
        assert_eq!(found.totals.get(Same).files, 2);
    }

    #[tokio::test]
    async fn a_missing_root_fails_the_walk() {
        let dir = tempfile::tempdir().unwrap();
        let err = walk(
            local(),
            4,
            &s(&dir.path().join("nope")),
            &|_, _| false,
            None,
            &Quiet,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "notFound");
    }
}

#[cfg(test)]
mod bench {
    /// Time a local walk of `$IRIS_WALK_BENCH_DIR` (read-only). Run with
    /// `IRIS_WALK_BENCH_DIR=… cargo test -p iris-core --release --lib
    /// local_walk_benchmark -- --ignored --nocapture`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn local_walk_benchmark() {
        let Ok(dir) = std::env::var("IRIS_WALK_BENCH_DIR") else {
            return;
        };
        let side = crate::transfer::side::Side::Local(crate::fs::LocalFs::new());
        for _ in 0..3 {
            let started = std::time::Instant::now();
            let listed = super::walk(
                vec![side.clone()],
                crate::fs::LOCAL_LISTINGS,
                &dir,
                &|_, _| false,
                None,
                &super::Quiet,
            )
            .await
            .unwrap();
            let dirs = listed.iter().filter(|l| l.node == super::Node::Dir).count();
            eprintln!(
                "local walk of {dir}: {} folders, {} entries in {:?}",
                dirs,
                listed.len(),
                started.elapsed()
            );
        }
    }
}
