//! A small filesystem abstraction shared by the local disk and SFTP, so the
//! panes (and later transfers) treat both sides the same way.
//!
//! Paths are plain strings: OS paths for [`LocalFs`], POSIX paths for
//! [`SftpFs`]. Listings are unsorted; ordering and filtering (hidden files)
//! are presentation concerns of the UI.

mod local;
mod sftp;

use std::future::Future;

use serde::{Deserialize, Serialize};

use crate::error::CoreResult;
use crate::ids::SessionId;

pub use local::LocalFs;
pub use sftp::SftpFs;

/// Which filesystem a call addresses. On the wire:
/// `{ "kind": "local" }` or `{ "kind": "remote", "sessionId": "…" }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsTarget {
    Local,
    Remote { session_id: SessionId },
}

/// One file, folder or link in a listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Full path, usable as the argument of the next `list_dir`/`stat`.
    pub path: String,
    pub kind: EntryKind,
    /// Size in bytes (of the link itself for a symlink); 0 when unknown.
    pub size: u64,
    /// Last modification, unix seconds; `None` when the server omits it.
    pub mtime: Option<i64>,
    /// Unix mode bits (type + permissions), when known. The UI derives the
    /// `rwxr-xr-x` string from it.
    pub mode: Option<u32>,
    /// Dotfile (or, on Windows, the hidden attribute).
    pub hidden: bool,
}

/// What an [`Entry`] is. On the wire: `{ "type": "file" }`, `{ "type": "dir" }`,
/// `{ "type": "other" }` (sockets, devices, fifos) or
/// `{ "type": "symlink", "target": "…", "targetKind": "dir" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EntryKind {
    File,
    Dir,
    /// A symbolic link. `target` is the raw link text (`None` if it could not
    /// be read); `target_kind` is what it resolves to (`None` when broken),
    /// so the UI can follow links to folders.
    Symlink {
        target: Option<String>,
        target_kind: Option<LinkTargetKind>,
    },
    Other,
}

/// What a symlink resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkTargetKind {
    File,
    Dir,
}

/// The operations the browsing panes need, implemented by [`LocalFs`] and
/// [`SftpFs`]. Futures are `Send` so they can run on any runtime thread
/// (Tauri's async commands require it).
pub trait FileSystem {
    /// The entries of the folder at `path` (without `.` and `..`).
    fn list(&self, path: &str) -> impl Future<Output = CoreResult<Vec<Entry>>> + Send;

    /// One entry, without following a final symlink (the entry *is* the
    /// link; its `targetKind` says where it leads).
    fn stat(&self, path: &str) -> impl Future<Output = CoreResult<Entry>> + Send;

    /// The raw target text of the symlink at `path`.
    fn read_link(&self, path: &str) -> impl Future<Output = CoreResult<String>> + Send;

    /// The user's home (local) or login folder (remote), absolute.
    fn home(&self) -> impl Future<Output = CoreResult<String>> + Send;

    /// `path` made absolute with links and `..` resolved.
    fn canonicalize(&self, path: &str) -> impl Future<Output = CoreResult<String>> + Send;
}

/// The unix file-type bits of a mode.
const S_IFMT: u32 = 0o170_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFREG: u32 = 0o100_000;
const S_IFLNK: u32 = 0o120_000;

/// Coarse type from unix mode bits.
pub(crate) fn kind_from_mode(mode: u32) -> ModeKind {
    match mode & S_IFMT {
        S_IFDIR => ModeKind::Dir,
        S_IFREG => ModeKind::File,
        S_IFLNK => ModeKind::Symlink,
        _ => ModeKind::Other,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModeKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// Dotfiles are hidden on every platform.
pub(crate) fn is_dotfile(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

/// Join a POSIX parent path and a child name with exactly one `/`.
pub(crate) fn join_posix(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

/// The last segment of a POSIX path (`/` for the root).
pub(crate) fn posix_name(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_string();
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_serializes_kind_tagged() {
        assert_eq!(
            serde_json::to_value(FsTarget::Local).unwrap(),
            serde_json::json!({ "kind": "local" })
        );
        let id = SessionId::new();
        let remote = FsTarget::Remote { session_id: id };
        let json = serde_json::to_value(remote).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "remote", "sessionId": id.to_string() })
        );
        let back: FsTarget = serde_json::from_value(json).unwrap();
        assert_eq!(back, remote);
    }

    #[test]
    fn entry_wire_shape() {
        let entry = Entry {
            name: "docs".into(),
            path: "/srv/docs".into(),
            kind: EntryKind::Symlink {
                target: Some("real-docs".into()),
                target_kind: Some(LinkTargetKind::Dir),
            },
            size: 9,
            mtime: Some(1_700_000_000),
            mode: Some(0o120_777),
            hidden: false,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["kind"]["type"], "symlink");
        assert_eq!(json["kind"]["target"], "real-docs");
        assert_eq!(json["kind"]["targetKind"], "dir");
        assert_eq!(json["mtime"], 1_700_000_000);
        assert_eq!(
            serde_json::to_value(EntryKind::File).unwrap(),
            serde_json::json!({ "type": "file" })
        );
    }

    #[test]
    fn mode_kinds() {
        assert_eq!(kind_from_mode(0o040_755), ModeKind::Dir);
        assert_eq!(kind_from_mode(0o100_644), ModeKind::File);
        assert_eq!(kind_from_mode(0o120_777), ModeKind::Symlink);
        assert_eq!(kind_from_mode(0o140_755), ModeKind::Other);
    }

    #[test]
    fn posix_helpers() {
        assert_eq!(join_posix("/", "a"), "/a");
        assert_eq!(join_posix("/srv", "a"), "/srv/a");
        assert_eq!(join_posix("/srv/", "a"), "/srv/a");
        assert_eq!(posix_name("/srv/a"), "a");
        assert_eq!(posix_name("/srv/a/"), "a");
        assert_eq!(posix_name("/"), "/");
        assert!(is_dotfile(".bashrc"));
        assert!(!is_dotfile("bashrc"));
        assert!(!is_dotfile(".."));
    }
}
