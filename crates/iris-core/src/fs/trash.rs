//! Where local deletes go: the OS Trash (Recycle Bin on Windows), behind a
//! trait so tests can swap in a fake and never litter the real Trash.

use std::path::Path;

use crate::error::{CoreError, CoreResult};

/// Moves local files and folders out of the way, recoverably.
pub trait Trash: Send + Sync {
    /// Move the file, folder (with everything in it) or symlink (the link
    /// itself) at `path` to the trash.
    fn trash(&self, path: &Path) -> CoreResult<()>;
}

/// The OS Trash via the `trash` crate.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemTrash;

impl Trash for SystemTrash {
    fn trash(&self, path: &Path) -> CoreResult<()> {
        let shown = path.to_string_lossy();
        // `symlink_metadata` so a broken link still counts as present.
        std::fs::symlink_metadata(path).map_err(|e| CoreError::from_io_at(e, &shown))?;
        context().delete(path).map_err(|e| {
            // The crate's error text can carry OS output; keep it at debug
            // and surface Iris-owned text only.
            tracing::debug!(error = %e, "moving to the trash failed");
            CoreError::Io(std::io::Error::other(format!(
                "could not move {shown} to the Trash"
            )))
        })
    }
}

#[cfg(target_os = "macos")]
fn context() -> trash::TrashContext {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    // NSFileManager needs no Finder automation permission (the default
    // Finder method would prompt for it) and is faster.
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx
}

#[cfg(not(target_os = "macos"))]
fn context() -> trash::TrashContext {
    trash::TrashContext::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_path_is_not_found_without_touching_the_trash() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(matches!(
            SystemTrash.trash(&missing),
            Err(CoreError::NotFound(_))
        ));
    }
}
