//! The local disk as a [`FileSystem`].
//!
//! Each call runs as one blocking task over `std::fs` instead of awaiting
//! `tokio::fs` per entry: a large folder then costs one thread hop rather
//! than several per file.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{CoreError, CoreResult};
use crate::fs::{is_dotfile, Entry, EntryKind, FileSystem, LinkTargetKind};

/// The local filesystem. Stateless; cheap to construct.
#[derive(Debug, Default, Clone, Copy)]
pub struct LocalFs;

impl LocalFs {
    pub fn new() -> Self {
        Self
    }
}

/// Run blocking filesystem work off the async runtime.
async fn blocking<T, F>(f: F) -> CoreResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CoreResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| CoreError::Io(std::io::Error::other("filesystem task failed")))?
}

impl FileSystem for LocalFs {
    async fn list(&self, path: &str) -> CoreResult<Vec<Entry>> {
        let path = path.to_string();
        blocking(move || {
            let dir = std::fs::read_dir(&path).map_err(|e| CoreError::from_io_at(e, &path))?;
            let mut entries = Vec::new();
            for item in dir {
                // An entry that vanishes or cannot be read between listing
                // and stat'ing is skipped rather than failing the folder.
                let Ok(item) = item else { continue };
                let name = item.file_name().to_string_lossy().into_owned();
                if let Ok(entry) = entry_at(&item.path(), name) {
                    entries.push(entry);
                }
            }
            Ok(entries)
        })
        .await
    }

    async fn stat(&self, path: &str) -> CoreResult<Entry> {
        let path = path.to_string();
        blocking(move || {
            let p = Path::new(&path);
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            entry_at(p, name).map_err(|e| CoreError::from_io_at(e, &path))
        })
        .await
    }

    async fn read_link(&self, path: &str) -> CoreResult<String> {
        let path = path.to_string();
        blocking(move || {
            std::fs::read_link(&path)
                .map(|t| t.to_string_lossy().into_owned())
                .map_err(|e| CoreError::from_io_at(e, &path))
        })
        .await
    }

    async fn home(&self) -> CoreResult<String> {
        std::env::home_dir()
            .map(|h| display(&h))
            .ok_or_else(|| CoreError::NotFound("home folder".into()))
    }

    async fn canonicalize(&self, path: &str) -> CoreResult<String> {
        let path = path.to_string();
        blocking(move || {
            std::fs::canonicalize(&path)
                .map(|p| display(&p))
                .map_err(|e| CoreError::from_io_at(e, &path))
        })
        .await
    }
}

/// Path as a string. On Windows, `canonicalize` returns verbatim
/// (`\\?\C:\…`) paths; the prefix is dropped for plain drive paths so the UI
/// shows (and later passes back) the familiar form.
fn display(path: &Path) -> String {
    let s = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if rest.as_bytes().get(1) == Some(&b':') {
                return rest.to_string();
            }
        }
    }
    s
}

/// Build an [`Entry`] for `path` without following a final symlink.
fn entry_at(path: &Path, name: String) -> std::io::Result<Entry> {
    let meta = std::fs::symlink_metadata(path)?;
    let file_type = meta.file_type();
    let kind = if file_type.is_symlink() {
        EntryKind::Symlink {
            target: std::fs::read_link(path)
                .ok()
                .map(|t| t.to_string_lossy().into_owned()),
            // `metadata` follows the link; an error means it is broken.
            target_kind: std::fs::metadata(path).ok().map(|m| {
                if m.is_dir() {
                    LinkTargetKind::Dir
                } else {
                    LinkTargetKind::File
                }
            }),
        }
    } else if file_type.is_dir() {
        EntryKind::Dir
    } else if file_type.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    let mtime = meta
        .modified()
        .ok()
        .map(|t| match t.duration_since(UNIX_EPOCH) {
            Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
            Err(before) => -i64::try_from(before.duration().as_secs()).unwrap_or(i64::MAX),
        });
    Ok(Entry {
        hidden: is_dotfile(&name) || windows_hidden(&meta),
        name,
        path: display(&PathBuf::from(path)),
        kind,
        size: meta.len(),
        mtime,
        mode: unix_mode(&meta),
    })
}

#[cfg(unix)]
fn unix_mode(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.mode())
}

#[cfg(not(unix))]
fn unix_mode(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(windows)]
fn windows_hidden(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn windows_hidden(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn find<'a>(entries: &'a [Entry], name: &str) -> &'a Entry {
        entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("{name} missing from {entries:?}"))
    }

    #[tokio::test]
    async fn lists_files_dirs_and_hidden_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "hello").unwrap();
        std::fs::write(dir.path().join(".hidden"), "").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let entries = LocalFs.list(&s(dir.path())).await.unwrap();
        assert_eq!(entries.len(), 3);
        let notes = find(&entries, "notes.txt");
        assert_eq!(notes.kind, EntryKind::File);
        assert_eq!(notes.size, 5);
        assert!(notes.mtime.is_some());
        assert!(!notes.hidden);
        assert_eq!(notes.path, s(&dir.path().join("notes.txt")));
        assert!(find(&entries, ".hidden").hidden);
        assert_eq!(find(&entries, "sub").kind, EntryKind::Dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_report_their_target_and_kind() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("real")).unwrap();
        std::fs::write(dir.path().join("file.txt"), "x").unwrap();
        std::os::unix::fs::symlink("real", dir.path().join("to-dir")).unwrap();
        std::os::unix::fs::symlink("file.txt", dir.path().join("to-file")).unwrap();
        std::os::unix::fs::symlink("nowhere", dir.path().join("broken")).unwrap();

        let entries = LocalFs.list(&s(dir.path())).await.unwrap();
        assert_eq!(
            find(&entries, "to-dir").kind,
            EntryKind::Symlink {
                target: Some("real".into()),
                target_kind: Some(LinkTargetKind::Dir),
            }
        );
        assert_eq!(
            find(&entries, "to-file").kind,
            EntryKind::Symlink {
                target: Some("file.txt".into()),
                target_kind: Some(LinkTargetKind::File),
            }
        );
        assert_eq!(
            find(&entries, "broken").kind,
            EntryKind::Symlink {
                target: Some("nowhere".into()),
                target_kind: None,
            }
        );

        let link = s(&dir.path().join("to-dir"));
        assert_eq!(LocalFs.read_link(&link).await.unwrap(), "real");
        let stat = LocalFs.stat(&link).await.unwrap();
        assert_eq!(stat.name, "to-dir");
        assert!(matches!(stat.kind, EntryKind::Symlink { .. }));
        // Following the link lands in the real folder.
        let real = LocalFs.canonicalize(&link).await.unwrap();
        assert_eq!(
            real,
            s(&std::fs::canonicalize(dir.path().join("real")).unwrap())
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mode_carries_type_and_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("script.sh");
        std::fs::write(&file, "").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o750)).unwrap();
        let entry = LocalFs.stat(&s(&file)).await.unwrap();
        assert_eq!(entry.mode.unwrap() & 0o170_777, 0o100_750);
    }

    #[tokio::test]
    async fn missing_paths_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let missing = s(&dir.path().join("nope"));
        assert!(matches!(
            LocalFs.list(&missing).await,
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            LocalFs.stat(&missing).await,
            Err(CoreError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn home_is_an_existing_folder() {
        let home = LocalFs.home().await.unwrap();
        assert!(Path::new(&home).is_dir());
    }
}
