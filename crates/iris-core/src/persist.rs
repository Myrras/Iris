//! Shared helpers for the files Iris writes: the JSON documents in its app
//! data dir (`settings.json`, `profiles.json`) and exports (a transfer
//! CSV).

use std::path::Path;

use serde::Serialize;

use crate::error::{CoreError, CoreResult};

/// Atomically persist `value` as pretty JSON: write a temp file next to
/// `path`, then rename it over the old one so a crash mid-write can never
/// leave a torn file. `what` names the document in the error text.
pub(crate) fn write_json_atomic<T: Serialize>(
    path: &Path,
    value: &T,
    what: &str,
) -> CoreResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| CoreError::Config(format!("failed to encode {what}: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Atomically write `bytes` to `path`: a temp file next to it (hidden,
/// named after it), then a rename over the old one, so a reader never sees
/// half a file. The folder must exist.
pub(crate) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> CoreResult<()> {
    let at = |e| CoreError::from_io_at(e, &path.to_string_lossy());
    let dir = path
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("the file needs a folder".into()))?;
    let name = path
        .file_name()
        .ok_or_else(|| CoreError::InvalidInput("the file needs a name".into()))?;
    if !dir.is_dir() {
        return Err(CoreError::NotFound(dir.to_string_lossy().into_owned()));
    }
    let tmp = dir.join(format!(".{}.tmp", name.to_string_lossy()));
    if let Err(e) = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(at(e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_bytes_atomically_and_replaces_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.csv");
        std::fs::write(&path, "old").unwrap();
        write_bytes_atomic(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(names.len(), 1, "no temp file left");
        let err = write_bytes_atomic(&dir.path().join("missing/x.csv"), b"x").unwrap_err();
        assert_eq!(err.kind(), "notFound");
    }
}
