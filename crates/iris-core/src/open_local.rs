//! Open a local file in its application, or show it in the file manager.
//!
//! Both go through the injected [`crate::Opener`] (the shell's, tests use a
//! fake). The core only validates the path first: it must be absolute (so
//! it cannot be read as an option or a relative lookup by the OS), exist,
//! and — for opening — be a file or an application bundle (`*.app`, a
//! folder on macOS). Folders are navigated in the UI, never opened here.

use std::path::Path;

use crate::edit::extension;
use crate::{Core, CoreError, CoreResult};

impl Core {
    /// Open the local file `path` with the application set for its
    /// extension in `editorOverrides` (the same lookup as remote edit), or
    /// the OS default.
    pub fn open_local(&self, path: &str) -> CoreResult<()> {
        let path = self.checked_openable(path)?;
        let settings = self.settings();
        let app = extension(&path).and_then(|ext| settings.editor_overrides.get(&ext));
        self.opener().open(&path, app.map(String::as_str))
    }

    /// Open the local file `path` with the OS default application,
    /// ignoring `editorOverrides`.
    pub fn open_local_default(&self, path: &str) -> CoreResult<()> {
        let path = self.checked_openable(path)?;
        self.opener().open(&path, None)
    }

    /// Show `path` (a file or a folder) selected in the OS file manager.
    pub fn reveal_local(&self, path: &str) -> CoreResult<()> {
        let path = absolute(path)?;
        // Not following links: a broken link can still be revealed.
        std::fs::symlink_metadata(path).map_err(|e| not_found_or_io(path, e))?;
        self.opener().reveal(path)
    }

    fn checked_openable(&self, path: &str) -> CoreResult<std::path::PathBuf> {
        let path = absolute(path)?;
        let meta = std::fs::metadata(path).map_err(|e| not_found_or_io(path, e))?;
        let bundle = meta.is_dir() && extension(path).as_deref() == Some("app");
        if !meta.is_file() && !bundle {
            return Err(CoreError::InvalidInput(
                "only files and applications can be opened".into(),
            ));
        }
        Ok(path.to_path_buf())
    }
}

fn absolute(path: &str) -> CoreResult<&Path> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(CoreError::InvalidInput("the path must be absolute".into()));
    }
    Ok(path)
}

/// Error text names the entry, never the whole path or the OS message.
fn not_found_or_io(path: &Path, e: std::io::Error) -> CoreError {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "the item".into());
    match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::NotFound(name),
        std::io::ErrorKind::PermissionDenied => CoreError::PermissionDenied(name),
        _ => CoreError::Io(e),
    }
}
