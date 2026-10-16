//! Walking one side of a sync into the flat list [`super::diff::diff`]
//! compares. The transfer engine's rules apply: names must be one plain
//! segment, a link to a file counts as that file (its size and date), and
//! folder links, broken links and sockets/devices are not followed but
//! listed as unsupported, with the reason.

use crate::error::{CoreError, CoreResult};
use crate::fs::{EntryKind, LinkTargetKind};
use crate::transfer::naming::is_safe_name;
use crate::transfer::side::Side;
use crate::transfer::{BROKEN_LINK, DIR_LINK, SPECIAL, UNSAFE_NAME};

use super::diff::{Listed, Node};

/// Every entry below the folder `root`, depth-first in name order. Folders
/// for which `prune(name, hidden)` holds are listed but not walked into
/// (excluded or hidden ones: their contents are never touched anyway).
///
/// A subfolder that cannot be listed (permission denied, …) becomes
/// unsupported, so nothing under it is copied or deleted; the root failing,
/// or the connection going, fails the walk.
pub(crate) async fn walk(
    side: &Side,
    root: &str,
    prune: &(dyn Fn(&str, bool) -> bool + Sync),
) -> CoreResult<Vec<Listed>> {
    let mut out: Vec<Listed> = Vec::new();
    // (folder path, its segments, its index in `out`; `None` for the root)
    let mut stack: Vec<(String, Vec<String>, Option<usize>)> =
        vec![(root.to_string(), Vec::new(), None)];
    while let Some((dir, segments, index)) = stack.pop() {
        let mut entries = match side.list(&dir).await {
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
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let mut subfolders = Vec::new();
        for entry in entries {
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
                    } => match side.metadata(&entry.path).await {
                        Ok(Some(meta)) if !meta.is_dir => Node::File {
                            size: meta.size,
                            mtime: meta.mtime,
                        },
                        Ok(_) => unsupported(BROKEN_LINK),
                        Err(e) if is_connection(&e) => return Err(e),
                        Err(_) => unsupported(BROKEN_LINK),
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
            if node == Node::Dir && !prune(&entry.name, entry.hidden) {
                subfolders.push((entry.path.clone(), path.clone(), out.len()));
            }
            out.push(Listed {
                segments: path,
                node,
                hidden: entry.hidden,
            });
        }
        // Reversed so the stack pops them in name order.
        for (path, segments, index) in subfolders.into_iter().rev() {
            stack.push((path, segments, Some(index)));
        }
    }
    Ok(out)
}

/// The connection is gone (or not answering): the walk cannot go on.
pub(crate) fn is_connection(err: &CoreError) -> bool {
    matches!(err, CoreError::NotConnected | CoreError::NoAnswer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;

    fn s(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn walks_depth_first_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/c.txt"), "abc").unwrap();
        std::fs::write(root.join("z.txt"), "z").unwrap();
        std::fs::create_dir_all(root.join("skip/deep")).unwrap();
        let side = Side::Local(LocalFs::new());
        let listed = walk(&side, &s(root), &|name, _| name == "skip")
            .await
            .unwrap();
        let paths: Vec<String> = listed.iter().map(|l| l.segments.join("/")).collect();
        assert_eq!(paths, vec!["a", "skip", "z.txt", "a/b", "a/b/c.txt"]);
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
        let side = Side::Local(LocalFs::new());
        let listed = walk(&side, &s(root), &|_, _| false).await.unwrap();
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
        let side = Side::Local(LocalFs::new());
        let err = walk(&side, &s(&dir.path().join("nope")), &|_, _| false)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "notFound");
    }
}
