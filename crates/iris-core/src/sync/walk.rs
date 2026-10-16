//! Walking one side of a sync into the flat list [`super::diff::diff`]
//! compares. The transfer engine's rules apply: names must be one plain
//! segment, a link to a file counts as that file (its size and date), and
//! folder links, broken links and sockets/devices are not followed but
//! listed as unsupported, with the reason.

use crate::error::CoreResult;
use crate::fs::walk::{is_connection, FolderWalk, ListFolder};
use crate::fs::{EntryKind, LinkTargetKind};
use crate::transfer::naming::is_safe_name;
use crate::transfer::{BROKEN_LINK, DIR_LINK, SPECIAL, UNSAFE_NAME};

use super::diff::{Listed, Node};

/// Counts a walk reports as it goes: `folder(files)` per folder listed,
/// with the number of files in it.
pub(crate) trait WalkProgress: Sync {
    fn folder(&self, files: u64);
}

/// No progress wanted.
pub(crate) struct Quiet;

impl WalkProgress for Quiet {
    fn folder(&self, _files: u64) {}
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
pub(crate) async fn walk<L: ListFolder>(
    listers: Vec<L>,
    limit: usize,
    root: &str,
    prune: &(dyn Fn(&str, bool) -> bool + Sync),
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
                    out[i].node = Node::Unsupported("the folder could not be read".into());
                }
                continue;
            }
        };
        let mut files = 0;
        for walked in entries {
            let entry = &walked.entry;
            let mut path = segments.clone();
            path.push(entry.name.clone());
            let unsupported = |why: &str| Node::Unsupported(why.to_string());
            let node = if !is_safe_name(&entry.name) {
                unsupported(UNSAFE_NAME)
            } else {
                match entry.kind {
                    EntryKind::File => Node::File {
                        size: entry.size,
                        mtime: entry.mtime,
                    },
                    EntryKind::Dir => Node::Dir,
                    EntryKind::Symlink {
                        target_kind: Some(LinkTargetKind::File),
                        ..
                    } => match walked.target {
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
            };
            if matches!(node, Node::File { .. }) {
                files += 1;
            }
            if node == Node::Dir && !prune(&entry.name, entry.hidden) {
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
    // Listings finish in any order: sort for a stable result.
    out.sort_by(|a, b| a.segments.cmp(&b.segments));
    Ok(out)
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
        let listed = walk(local(), 4, &s(root), &|name, _| name == "skip", &Quiet)
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
        let listed = walk(local(), 4, &s(root), &|_, _| false, &Quiet)
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

    #[tokio::test]
    async fn a_missing_root_fails_the_walk() {
        let dir = tempfile::tempdir().unwrap();
        let err = walk(
            local(),
            4,
            &s(&dir.path().join("nope")),
            &|_, _| false,
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
