//! The core's [`Opener`] for the desktop: hands a file to the user's editor
//! through tauri-plugin-opener's `open_path` (macOS `open [-a app]`,
//! Windows `ShellExecute` / the given executable). The plugin itself is not
//! registered, so the webview has no opener commands.

use std::path::Path;

use iris_core::{CoreError, CoreResult, Opener};

pub struct DesktopOpener;

impl Opener for DesktopOpener {
    fn open(&self, path: &Path, app: Option<&str>) -> CoreResult<()> {
        tauri_plugin_opener::open_path(path, app).map_err(|e| {
            // The OS error names paths at most; still, keep the message
            // Iris-owned and put the detail in the log.
            tracing::warn!("could not open a file in its editor: {e}");
            match app {
                Some(app) => CoreError::Config(format!("could not open the file with {app}")),
                None => CoreError::Config(
                    "could not open the file: no application is set for its type".into(),
                ),
            }
        })
    }
}
