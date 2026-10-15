//! The local disk as a [`FileSystem`].
//!
//! Each call runs as one blocking task over `std::fs` instead of awaiting
//! `tokio::fs` per entry: a large folder then costs one thread hop rather
//! than several per file.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use crate::error::{CoreError, CoreResult};
use crate::fs::{
    check_mode, is_dotfile, Entry, EntryKind, FileSystem, LinkTargetKind, ReadRange, SystemTrash,
    Trash,
};

/// The local filesystem. Cheap to clone; deletes go to its [`Trash`].
#[derive(Clone)]
pub struct LocalFs {
    trash: Arc<dyn Trash>,
}

impl Default for LocalFs {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for LocalFs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalFs").finish_non_exhaustive()
    }
}

impl LocalFs {
    /// Deletes go to the OS Trash.
    pub fn new() -> Self {
        Self::with_trash(Arc::new(SystemTrash))
    }

    /// Deletes go to `trash` (tests pass a fake).
    pub fn with_trash(trash: Arc<dyn Trash>) -> Self {
        Self { trash }
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

    async fn mkdir(&self, path: &str) -> CoreResult<()> {
        let path = path.to_string();
        blocking(move || std::fs::create_dir(&path).map_err(|e| CoreError::from_io_at(e, &path)))
            .await
    }

    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        let (from, to) = (from.to_string(), to.to_string());
        blocking(move || {
            if from == to {
                return Ok(());
            }
            std::fs::symlink_metadata(&from).map_err(|e| CoreError::from_io_at(e, &from))?;
            // `std::fs::rename` replaces an existing file on unix, so refuse
            // up front. A case-only rename on a case-insensitive disk finds
            // the entry itself at `to`; that one is allowed.
            if std::fs::symlink_metadata(&to).is_ok() && !same_entry(&from, &to) {
                return Err(CoreError::AlreadyExists(to));
            }
            std::fs::rename(&from, &to).map_err(|e| CoreError::from_io_at(e, &from))
        })
        .await
    }

    async fn remove(&self, path: &str) -> CoreResult<()> {
        let path = path.to_string();
        let trash = Arc::clone(&self.trash);
        blocking(move || trash.trash(Path::new(&path))).await
    }

    async fn chmod(&self, path: &str, mode: u32, recursive: bool) -> CoreResult<()> {
        check_mode(mode)?;
        let path = path.to_string();
        blocking(move || chmod_tree(Path::new(&path), mode, recursive)).await
    }

    async fn read_range(&self, path: &str, offset: u64, max_bytes: u64) -> CoreResult<ReadRange> {
        let path = path.to_string();
        blocking(move || {
            let at = |e| CoreError::from_io_at(e, &path);
            let mut file = std::fs::File::open(&path).map_err(at)?;
            let meta = file.metadata().map_err(at)?;
            if meta.is_dir() {
                return Err(CoreError::InvalidInput(format!("{path} is a folder")));
            }
            let total_size = meta.len();
            file.seek(SeekFrom::Start(offset)).map_err(at)?;
            let capacity = max_bytes.min(total_size.saturating_sub(offset));
            let mut bytes = Vec::with_capacity(usize::try_from(capacity).unwrap_or(0));
            file.take(max_bytes).read_to_end(&mut bytes).map_err(at)?;
            Ok(ReadRange {
                truncated: offset + (bytes.len() as u64) < total_size,
                bytes,
                total_size,
            })
        })
        .await
    }
}

/// Whether `from` and `to` name the same entry (a case-only rename on a
/// case-insensitive disk).
#[cfg(unix)]
fn same_entry(from: &str, to: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (
        std::fs::symlink_metadata(from),
        std::fs::symlink_metadata(to),
    ) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Windows disks are case-insensitive: names that differ only in case are
/// the same entry.
#[cfg(not(unix))]
fn same_entry(from: &str, to: &str) -> bool {
    from.to_lowercase() == to.to_lowercase()
}

/// chmod `root` and, with `recursive`, everything below it (symlinks
/// skipped). Keeps going after a failure and reports the first one.
#[cfg(unix)]
fn chmod_tree(root: &Path, mode: u32, recursive: bool) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let set = |p: &Path| {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode))
            .map_err(|e| CoreError::from_io_at(e, &p.to_string_lossy()))
    };
    let meta = std::fs::symlink_metadata(root)
        .map_err(|e| CoreError::from_io_at(e, &root.to_string_lossy()))?;
    if !recursive || !meta.is_dir() {
        return set(root);
    }
    let folder_first = crate::fs::chmod_folder_first(mode);
    let mut first_error = None;
    let mut note = |r: CoreResult<()>| {
        if let Err(e) = r {
            first_error.get_or_insert(e);
        }
    };
    // Depth-first; `(path, children_done)` lets a folder be revisited after
    // its contents when it goes bottom-up.
    let mut stack = vec![(root.to_path_buf(), false)];
    while let Some((path, children_done)) = stack.pop() {
        if children_done {
            note(set(&path));
            continue;
        }
        if folder_first {
            note(set(&path));
        } else {
            stack.push((path.clone(), true));
        }
        let items = match std::fs::read_dir(&path) {
            Ok(items) => items,
            Err(e) => {
                note(Err(CoreError::from_io_at(e, &path.to_string_lossy())));
                continue;
            }
        };
        for item in items.flatten() {
            let child = item.path();
            match std::fs::symlink_metadata(&child) {
                Ok(m) if m.is_dir() => stack.push((child, false)),
                Ok(m) if m.file_type().is_symlink() => {}
                Ok(_) => note(set(&child)),
                Err(e) => note(Err(CoreError::from_io_at(e, &child.to_string_lossy()))),
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(not(unix))]
fn chmod_tree(_root: &Path, _mode: u32, _recursive: bool) -> CoreResult<()> {
    Err(CoreError::InvalidInput(
        "permissions cannot be changed on this system".into(),
    ))
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

        let entries = LocalFs::new().list(&s(dir.path())).await.unwrap();
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

        let entries = LocalFs::new().list(&s(dir.path())).await.unwrap();
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
        assert_eq!(LocalFs::new().read_link(&link).await.unwrap(), "real");
        let stat = LocalFs::new().stat(&link).await.unwrap();
        assert_eq!(stat.name, "to-dir");
        assert!(matches!(stat.kind, EntryKind::Symlink { .. }));
        // Following the link lands in the real folder.
        let real = LocalFs::new().canonicalize(&link).await.unwrap();
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
        let entry = LocalFs::new().stat(&s(&file)).await.unwrap();
        assert_eq!(entry.mode.unwrap() & 0o170_777, 0o100_750);
    }

    #[tokio::test]
    async fn missing_paths_are_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let missing = s(&dir.path().join("nope"));
        assert!(matches!(
            LocalFs::new().list(&missing).await,
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            LocalFs::new().stat(&missing).await,
            Err(CoreError::NotFound(_))
        ));
    }

    /// Records what was trashed and moves it into a holding folder, so the
    /// real Trash is never touched.
    struct FakeTrash {
        bin: PathBuf,
    }

    impl Trash for FakeTrash {
        fn trash(&self, path: &Path) -> CoreResult<()> {
            let name = path.file_name().unwrap();
            std::fs::rename(path, self.bin.join(name))
                .map_err(|e| CoreError::from_io_at(e, &path.to_string_lossy()))
        }
    }

    fn with_fake_trash(bin: &Path) -> LocalFs {
        LocalFs::with_trash(Arc::new(FakeTrash {
            bin: bin.to_path_buf(),
        }))
    }

    #[tokio::test]
    async fn mkdir_creates_and_refuses_an_existing_name() {
        let dir = tempfile::tempdir().unwrap();
        let fs = LocalFs::new();
        let target = s(&dir.path().join("untitled folder"));
        fs.mkdir(&target).await.unwrap();
        assert!(dir.path().join("untitled folder").is_dir());
        assert!(matches!(
            fs.mkdir(&target).await,
            Err(CoreError::AlreadyExists(p)) if p == target
        ));
        let file = dir.path().join("taken.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(matches!(
            fs.mkdir(&s(&file)).await,
            Err(CoreError::AlreadyExists(_))
        ));
    }

    #[tokio::test]
    async fn rename_moves_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let fs = LocalFs::new();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        std::fs::write(&a, "alpha").unwrap();
        fs.rename(&s(&a), &s(&b)).await.unwrap();
        assert!(!a.exists());
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "alpha");

        std::fs::write(&a, "other").unwrap();
        assert!(matches!(
            fs.rename(&s(&a), &s(&b)).await,
            Err(CoreError::AlreadyExists(p)) if p == s(&b)
        ));
        // Neither file changed.
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "other");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "alpha");

        assert!(matches!(
            fs.rename(&s(&dir.path().join("gone")), &s(&dir.path().join("x")))
                .await,
            Err(CoreError::NotFound(_))
        ));
        // Renaming onto itself is a no-op.
        fs.rename(&s(&a), &s(&a)).await.unwrap();
    }

    #[tokio::test]
    async fn a_case_only_rename_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let fs = LocalFs::new();
        let lower = dir.path().join("readme.md");
        std::fs::write(&lower, "x").unwrap();
        let upper = dir.path().join("README.md");
        fs.rename(&s(&lower), &s(&upper)).await.unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["README.md"]);
    }

    #[tokio::test]
    async fn remove_goes_to_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let folder = dir.path().join("old");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        std::fs::write(folder.join("nested").join("f.txt"), "x").unwrap();

        with_fake_trash(bin.path())
            .remove(&s(&folder))
            .await
            .unwrap();
        assert!(!folder.exists());
        assert!(bin.path().join("old/nested/f.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn chmod_sets_bits_and_recurses_without_following_links() {
        use std::os::unix::fs::PermissionsExt;
        let mode_of =
            |p: &Path| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o7777;
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "x").unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o600)).unwrap();
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(tree.join("sub")).unwrap();
        std::fs::write(tree.join("sub/f.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, tree.join("link")).unwrap();
        let fs = LocalFs::new();

        // Not recursive: only the folder itself.
        fs.chmod(&s(&tree), 0o700, false).await.unwrap();
        assert_eq!(mode_of(&tree), 0o700);
        assert_ne!(mode_of(&tree.join("sub/f.txt")), 0o700);

        fs.chmod(&s(&tree), 0o750, true).await.unwrap();
        assert_eq!(mode_of(&tree), 0o750);
        assert_eq!(mode_of(&tree.join("sub")), 0o750);
        assert_eq!(mode_of(&tree.join("sub/f.txt")), 0o750);
        // The link's target outside the tree is untouched.
        assert_eq!(mode_of(&outside), 0o600);

        // Closing modes go bottom-up, so the walk still reaches the files.
        fs.chmod(&s(&tree), 0o644, true).await.unwrap();
        assert_eq!(mode_of(&tree), 0o644);
        // Reopen the folders to look inside (and let the temp dir clean up).
        std::fs::set_permissions(&tree, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(mode_of(&tree.join("sub")), 0o644);
        std::fs::set_permissions(tree.join("sub"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(mode_of(&tree.join("sub/f.txt")), 0o644);

        assert!(matches!(
            fs.chmod(&s(&outside), 0o10000, false).await,
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn read_range_reads_a_capped_slice() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data.txt");
        std::fs::write(&file, "0123456789").unwrap();
        let fs = LocalFs::new();

        let all = fs.read_range(&s(&file), 0, 100).await.unwrap();
        assert_eq!(all.bytes, b"0123456789");
        assert_eq!(all.total_size, 10);
        assert!(!all.truncated);

        let head = fs.read_range(&s(&file), 0, 4).await.unwrap();
        assert_eq!(head.bytes, b"0123");
        assert!(head.truncated);

        let tail = fs.read_range(&s(&file), 6, 4).await.unwrap();
        assert_eq!(tail.bytes, b"6789");
        assert!(!tail.truncated);

        assert!(matches!(
            fs.read_range(&s(dir.path()), 0, 4).await,
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn home_is_an_existing_folder() {
        let home = LocalFs::new().home().await.unwrap();
        assert!(Path::new(&home).is_dir());
    }
}
