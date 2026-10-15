//! A remote folder tree over SFTP as a [`FileSystem`] (russh-sftp client).

use std::sync::Arc;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, StatusCode};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::task::JoinSet;

use crate::error::{CoreError, CoreResult};
use crate::fs::{
    check_mode, chmod_folder_first, is_dotfile, join_posix, kind_from_mode, posix_name, Entry,
    EntryKind, FileSystem, LinkTargetKind, ModeKind, ReadRange,
};

/// The SFTP view of one live session. Cloning shares the same channel.
#[derive(Clone)]
pub struct SftpFs {
    sftp: Arc<SftpSession>,
}

impl SftpFs {
    pub fn new(sftp: SftpSession) -> Self {
        Self {
            sftp: Arc::new(sftp),
        }
    }

    /// Close the SFTP channel (best effort; the SSH session closes too).
    pub async fn close(&self) {
        let _ = self.sftp.close().await;
    }
}

impl FileSystem for SftpFs {
    async fn list(&self, path: &str) -> CoreResult<Vec<Entry>> {
        let dir = self
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| map_err(e, path))?;
        let mut entries = Vec::new();
        // Symlinks need two extra round trips each (readlink + stat). They
        // are resolved concurrently over the one channel; plain entries
        // already carry everything from READDIR.
        let mut links = JoinSet::new();
        for item in dir {
            let name = item.file_name();
            let entry_path = join_posix(path, &name);
            let attrs = item.metadata();
            let entry = entry_from_attrs(name, entry_path.clone(), &attrs);
            if matches!(entry.kind, EntryKind::Symlink { .. }) {
                let sftp = Arc::clone(&self.sftp);
                let index = entries.len();
                links.spawn(async move { (index, resolve_link(&sftp, &entry_path).await) });
            }
            entries.push(entry);
        }
        while let Some(joined) = links.join_next().await {
            if let Ok((index, kind)) = joined {
                entries[index].kind = kind;
            }
        }
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> CoreResult<Entry> {
        let attrs = self
            .sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| map_err(e, path))?;
        let mut entry = entry_from_attrs(posix_name(path), path.to_string(), &attrs);
        if matches!(entry.kind, EntryKind::Symlink { .. }) {
            entry.kind = resolve_link(&self.sftp, path).await;
        }
        Ok(entry)
    }

    async fn read_link(&self, path: &str) -> CoreResult<String> {
        self.sftp
            .read_link(path)
            .await
            .map_err(|e| map_err(e, path))
    }

    async fn home(&self) -> CoreResult<String> {
        // An SFTP session starts in the login folder, so "." resolves to it.
        self.canonicalize(".").await
    }

    async fn canonicalize(&self, path: &str) -> CoreResult<String> {
        self.sftp
            .canonicalize(path)
            .await
            .map_err(|e| map_err(e, path))
    }

    async fn mkdir(&self, path: &str) -> CoreResult<()> {
        // Servers answer an existing name with a generic failure; look
        // first so the UI gets `alreadyExists`.
        if self.exists(path).await? {
            return Err(CoreError::AlreadyExists(path.to_string()));
        }
        self.sftp
            .create_dir(path)
            .await
            .map_err(|e| map_err(e, path))
    }

    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        if from == to {
            return Ok(());
        }
        self.sftp
            .symlink_metadata(from)
            .await
            .map_err(|e| map_err(e, from))?;
        // SFTP v3 RENAME may or may not replace an existing target depending
        // on the server; refuse up front so nothing is ever overwritten. A
        // case-only rename is left to the server (on a case-insensitive disk
        // the target "exists" as the entry itself).
        let case_only = from.to_lowercase() == to.to_lowercase();
        if !case_only && self.exists(to).await? {
            return Err(CoreError::AlreadyExists(to.to_string()));
        }
        self.sftp
            .rename(from, to)
            .await
            .map_err(|e| map_err(e, from))
    }

    async fn remove(&self, path: &str) -> CoreResult<()> {
        let attrs = self
            .sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| map_err(e, path))?;
        // Depth-first without recursion: `(path, is_dir, children_done)`.
        // Kinds come from LSTAT / READDIR (which do not follow links), so a
        // symlink to a folder is unlinked, never walked into.
        let mut stack = vec![(path.to_string(), is_real_dir(&attrs), false)];
        while let Some((current, is_dir, children_done)) = stack.pop() {
            if !is_dir {
                self.sftp
                    .remove_file(current.as_str())
                    .await
                    .map_err(|e| map_err(e, &current))?;
            } else if children_done {
                self.sftp
                    .remove_dir(current.as_str())
                    .await
                    .map_err(|e| map_err(e, &current))?;
            } else {
                let items = self
                    .sftp
                    .read_dir(current.as_str())
                    .await
                    .map_err(|e| map_err(e, &current))?;
                stack.push((current.clone(), true, true));
                for item in items {
                    let child = join_posix(&current, &item.file_name());
                    stack.push((child, is_real_dir(&item.metadata()), false));
                }
            }
        }
        Ok(())
    }

    async fn chmod(&self, path: &str, mode: u32, recursive: bool) -> CoreResult<()> {
        check_mode(mode)?;
        let attrs = self
            .sftp
            .symlink_metadata(path)
            .await
            .map_err(|e| map_err(e, path))?;
        if !recursive || !is_real_dir(&attrs) {
            return self.set_mode(path, mode).await;
        }
        let folder_first = chmod_folder_first(mode);
        let mut first_error = None;
        let mut stack = vec![(path.to_string(), false)];
        while let Some((current, children_done)) = stack.pop() {
            if children_done {
                if let Err(e) = self.set_mode(&current, mode).await {
                    first_error.get_or_insert(e);
                }
                continue;
            }
            if folder_first {
                if let Err(e) = self.set_mode(&current, mode).await {
                    first_error.get_or_insert(e);
                }
            } else {
                stack.push((current.clone(), true));
            }
            let items = match self.sftp.read_dir(current.as_str()).await {
                Ok(items) => items,
                Err(e) => {
                    let err = map_err(e, &current);
                    if matches!(err, CoreError::NotConnected) {
                        return Err(err);
                    }
                    first_error.get_or_insert(err);
                    continue;
                }
            };
            for item in items {
                let child = join_posix(&current, &item.file_name());
                let attrs = item.metadata();
                match attrs.permissions.map(kind_from_mode) {
                    Some(ModeKind::Dir) => stack.push((child, false)),
                    // SETSTAT follows links; leave them (and their targets) alone.
                    Some(ModeKind::Symlink) => {}
                    _ => {
                        if let Err(e) = self.set_mode(&child, mode).await {
                            if matches!(e, CoreError::NotConnected) {
                                return Err(e);
                            }
                            first_error.get_or_insert(e);
                        }
                    }
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    async fn read_range(&self, path: &str, offset: u64, max_bytes: u64) -> CoreResult<ReadRange> {
        // STAT follows links, as opening the file does.
        let attrs = self
            .sftp
            .metadata(path)
            .await
            .map_err(|e| map_err(e, path))?;
        if is_real_dir(&attrs) {
            return Err(CoreError::InvalidInput(format!("{path} is a folder")));
        }
        let total_size = attrs.size.unwrap_or(0);
        let mut file = self.sftp.open(path).await.map_err(|e| map_err(e, path))?;
        // Read errors arrive as `io::Error`s that can carry the server's own
        // message; never forward it.
        let read_failed = |_| CoreError::Remote(format!("could not read {path}"));
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(read_failed)?;
        let capacity = max_bytes.min(total_size.saturating_sub(offset));
        let mut bytes = Vec::with_capacity(usize::try_from(capacity).unwrap_or(0));
        (&mut file)
            .take(max_bytes)
            .read_to_end(&mut bytes)
            .await
            .map_err(read_failed)?;
        // Best effort: a failed close does not undo a successful read.
        let _ = file.close().await;
        Ok(ReadRange {
            truncated: offset + (bytes.len() as u64) < total_size,
            bytes,
            total_size,
        })
    }
}

impl SftpFs {
    /// Whether anything (a broken link included) is at `path`.
    async fn exists(&self, path: &str) -> CoreResult<bool> {
        match self.sftp.symlink_metadata(path).await {
            Ok(_) => Ok(true),
            Err(e) => match map_err(e, path) {
                CoreError::NotFound(_) => Ok(false),
                other => Err(other),
            },
        }
    }

    async fn set_mode(&self, path: &str, mode: u32) -> CoreResult<()> {
        let attrs = FileAttributes {
            permissions: Some(mode),
            ..FileAttributes::empty()
        };
        self.sftp
            .set_metadata(path, attrs)
            .await
            .map_err(|e| map_err(e, path))
    }
}

/// A folder itself (not a link to one).
fn is_real_dir(attrs: &FileAttributes) -> bool {
    attrs.permissions.map(kind_from_mode) == Some(ModeKind::Dir)
}

/// Read a link's text and what it resolves to; failures leave the fields
/// empty (an unreadable or broken link is still listed).
async fn resolve_link(sftp: &SftpSession, path: &str) -> EntryKind {
    let target = sftp.read_link(path).await.ok();
    // STAT (unlike LSTAT) follows the link.
    let target_kind =
        sftp.metadata(path)
            .await
            .ok()
            .map(|attrs| match attrs.permissions.map(kind_from_mode) {
                Some(ModeKind::Dir) => LinkTargetKind::Dir,
                _ => LinkTargetKind::File,
            });
    EntryKind::Symlink {
        target,
        target_kind,
    }
}

fn entry_from_attrs(name: String, path: String, attrs: &FileAttributes) -> Entry {
    let kind = match attrs.permissions.map(kind_from_mode) {
        Some(ModeKind::Dir) => EntryKind::Dir,
        Some(ModeKind::Symlink) => EntryKind::Symlink {
            target: None,
            target_kind: None,
        },
        Some(ModeKind::Other) => EntryKind::Other,
        // No mode at all: assume a plain file rather than hiding it.
        Some(ModeKind::File) | None => EntryKind::File,
    };
    Entry {
        hidden: is_dotfile(&name),
        name,
        path,
        kind,
        size: attrs.size.unwrap_or(0),
        mtime: attrs.mtime.map(i64::from),
        mode: attrs.permissions,
    }
}

/// Translate an SFTP client error into an Iris-owned [`CoreError`]. The
/// server's free-text message is deliberately dropped; only the status code
/// (whose text comes from the library) is kept.
pub(crate) fn map_err(err: SftpError, path: &str) -> CoreError {
    match err {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => CoreError::NotFound(path.to_string()),
            StatusCode::PermissionDenied => CoreError::PermissionDenied(path.to_string()),
            StatusCode::NoConnection | StatusCode::ConnectionLost => CoreError::NotConnected,
            code => CoreError::Remote(format!("{code} ({path})")),
        },
        SftpError::Timeout => CoreError::Remote("the server did not answer in time".into()),
        // The channel's stream failed: the connection is gone.
        SftpError::IO(_) => CoreError::NotConnected,
        SftpError::Limited(_) | SftpError::UnexpectedPacket | SftpError::UnexpectedBehavior(_) => {
            CoreError::Remote("unexpected SFTP response".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::Status;

    fn status(code: StatusCode) -> SftpError {
        SftpError::Status(Status {
            id: 1,
            status_code: code,
            error_message: "server-side text that must not leak".into(),
            language_tag: "en".into(),
        })
    }

    #[test]
    fn status_codes_map_to_core_kinds() {
        assert!(matches!(
            map_err(status(StatusCode::NoSuchFile), "/a"),
            CoreError::NotFound(p) if p == "/a"
        ));
        assert!(matches!(
            map_err(status(StatusCode::PermissionDenied), "/a"),
            CoreError::PermissionDenied(_)
        ));
        assert!(matches!(
            map_err(status(StatusCode::ConnectionLost), "/a"),
            CoreError::NotConnected
        ));
        assert!(matches!(
            map_err(SftpError::IO("closed".into()), "/a"),
            CoreError::NotConnected
        ));
    }

    #[test]
    fn the_server_message_is_never_forwarded() {
        let err = map_err(status(StatusCode::Failure), "/a");
        assert_eq!(err.kind(), "remote");
        assert!(!err.to_string().contains("must not leak"), "{err}");
    }

    #[test]
    fn attrs_become_entries() {
        let attrs = FileAttributes {
            size: Some(42),
            permissions: Some(0o100_644),
            mtime: Some(1_700_000_000),
            ..FileAttributes::default()
        };
        let entry = entry_from_attrs(".profile".into(), "/home/demo/.profile".into(), &attrs);
        assert_eq!(entry.kind, EntryKind::File);
        assert_eq!(entry.size, 42);
        assert_eq!(entry.mtime, Some(1_700_000_000));
        assert_eq!(entry.mode, Some(0o100_644));
        assert!(entry.hidden);

        let dir = FileAttributes {
            permissions: Some(0o040_755),
            ..FileAttributes::default()
        };
        assert_eq!(
            entry_from_attrs("d".into(), "/d".into(), &dir).kind,
            EntryKind::Dir
        );
    }
}
