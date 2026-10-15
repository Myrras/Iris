//! Shared helper for the JSON documents Iris keeps in its app data dir
//! (`settings.json`, `profiles.json`).

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
