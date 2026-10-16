//! Global app settings, persisted as one JSON file in the app data dir
//! (`settings.json`).
//!
//! These are the backend-relevant preferences (transfer parallelism, reconnect
//! policy, per-extension editor overrides, the names a sync leaves alone). Purely visual preferences (theme,
//! hidden files, preview cap) live in the frontend's `settingsStore`
//! (localStorage) instead, since nothing in the core needs them.
//!
//! Writes are atomic (temp file + rename); a missing or corrupt file is
//! treated as defaults. Until [`IrisSettingsStore::set_path`] is called the
//! store is in-memory only (tests, or a data dir that failed to resolve).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::persist::write_json_atomic;

const LOCK_POISONED: &str = "settings store lock poisoned";

/// Bounds for [`IrisSettings::parallel_transfers`].
pub const PARALLEL_TRANSFERS_RANGE: std::ops::RangeInclusive<u32> = 1..=16;
/// Bounds for [`IrisSettings::reconnect_attempts`] (0 = never reconnect).
pub const RECONNECT_ATTEMPTS_RANGE: std::ops::RangeInclusive<u32> = 0..=20;
/// The most [`IrisSettings::sync_excludes`] patterns kept.
pub const MAX_SYNC_EXCLUDES: usize = 100;
/// The longest sync exclude pattern, in characters.
pub const MAX_SYNC_EXCLUDE_LEN: usize = 255;

/// What a sync leaves alone unless the user changes it.
pub fn default_sync_excludes() -> Vec<String> {
    [".git", ".DS_Store", "node_modules", "Thumbs.db"]
        .map(String::from)
        .to_vec()
}

/// The whole persisted document. Every field has a default, so a file written
/// by an older version (missing newer fields) still loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IrisSettings {
    /// How many file transfers run at once.
    pub parallel_transfers: u32,
    /// How often a dropped connection is retried before giving up.
    pub reconnect_attempts: u32,
    /// Per-extension editor override: lower-case extension without the dot
    /// (`"md"`) → path of the app to open it with. Empty = the OS default.
    pub editor_overrides: BTreeMap<String, String>,
    /// Name patterns a sync never copies or deletes, matched against each
    /// path segment (`*` and `?` wildcards; see [`crate::sync::exclude`]).
    pub sync_excludes: Vec<String>,
}

impl Default for IrisSettings {
    fn default() -> Self {
        Self {
            parallel_transfers: 4,
            reconnect_attempts: 5,
            editor_overrides: BTreeMap::new(),
            sync_excludes: default_sync_excludes(),
        }
    }
}

impl IrisSettings {
    /// Validate the numeric fields and tidy the editor overrides: extensions
    /// are trimmed, lower-cased and lose a leading dot; entries with a blank
    /// extension or app path are dropped so the file stays clean.
    pub fn normalized(self) -> CoreResult<Self> {
        if !PARALLEL_TRANSFERS_RANGE.contains(&self.parallel_transfers) {
            return Err(CoreError::InvalidInput(format!(
                "parallel transfers must be between {} and {}",
                PARALLEL_TRANSFERS_RANGE.start(),
                PARALLEL_TRANSFERS_RANGE.end()
            )));
        }
        if !RECONNECT_ATTEMPTS_RANGE.contains(&self.reconnect_attempts) {
            return Err(CoreError::InvalidInput(format!(
                "reconnect attempts must be between {} and {}",
                RECONNECT_ATTEMPTS_RANGE.start(),
                RECONNECT_ATTEMPTS_RANGE.end()
            )));
        }
        let editor_overrides = self
            .editor_overrides
            .into_iter()
            .map(|(ext, app)| {
                let ext = ext.trim().trim_start_matches('.').to_lowercase();
                (ext, app.trim().to_string())
            })
            .filter(|(ext, app)| !ext.is_empty() && !app.is_empty())
            .collect();
        let sync_excludes = normalize_excludes(self.sync_excludes)?;
        Ok(Self {
            editor_overrides,
            sync_excludes,
            ..self
        })
    }
}

/// Trim the patterns and drop blanks and repeats (first one wins). A
/// pattern is one path segment, so a separator in it is refused.
pub(crate) fn normalize_excludes(patterns: Vec<String>) -> CoreResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for pattern in patterns {
        let pattern = pattern.trim();
        if pattern.is_empty() || out.iter().any(|p| p == pattern) {
            continue;
        }
        if pattern.contains(['/', '\\', '\0']) {
            return Err(CoreError::InvalidInput(format!(
                "the sync exclude {pattern:?} must be a name, without / or \\"
            )));
        }
        if pattern.chars().count() > MAX_SYNC_EXCLUDE_LEN {
            return Err(CoreError::InvalidInput(format!(
                "a sync exclude can be at most {MAX_SYNC_EXCLUDE_LEN} characters"
            )));
        }
        out.push(pattern.to_string());
    }
    if out.len() > MAX_SYNC_EXCLUDES {
        return Err(CoreError::InvalidInput(format!(
            "there can be at most {MAX_SYNC_EXCLUDES} sync excludes"
        )));
    }
    Ok(out)
}

struct Inner {
    path: Option<PathBuf>,
    settings: IrisSettings,
}

/// Thread-safe live copy of the settings, shared by the [`crate::Core`].
pub struct IrisSettingsStore {
    inner: Mutex<Inner>,
}

impl IrisSettingsStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                path: None,
                settings: IrisSettings::default(),
            }),
        }
    }

    /// Point the store at its backing file and load whatever is there. Any
    /// in-memory settings accumulated before this call are replaced.
    pub fn set_path(&self, path: PathBuf) {
        let settings = load(&path);
        let mut inner = self.inner.lock().expect(LOCK_POISONED);
        inner.path = Some(path);
        inner.settings = settings;
    }

    /// A clone of the current settings.
    pub fn get(&self) -> IrisSettings {
        self.inner.lock().expect(LOCK_POISONED).settings.clone()
    }

    /// Validate, normalize and persist `settings` as the new document;
    /// returns what was stored. On error nothing changes.
    pub fn save(&self, settings: IrisSettings) -> CoreResult<IrisSettings> {
        let settings = settings.normalized()?;
        let mut inner = self.inner.lock().expect(LOCK_POISONED);
        if let Some(path) = &inner.path {
            write_json_atomic(path, &settings, "settings")?;
        }
        inner.settings = settings.clone();
        Ok(settings)
    }
}

impl Default for IrisSettingsStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Read the settings from disk; a missing or corrupt file is defaults.
fn load(path: &Path) -> IrisSettings {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return IrisSettings::default();
    };
    // A hand-edited file with out-of-range numbers is treated like a corrupt
    // one rather than trusted.
    serde_json::from_str::<IrisSettings>(&raw)
        .map_err(|e| e.to_string())
        .and_then(|s| s.normalized().map_err(|e| e.to_string()))
        .unwrap_or_else(|e| {
            tracing::warn!("settings file is corrupt, using defaults: {e}");
            IrisSettings::default()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overrides(items: &[(&str, &str)]) -> BTreeMap<String, String> {
        items
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn defaults_match_the_spec() {
        let s = IrisSettings::default();
        assert_eq!(s.parallel_transfers, 4);
        assert_eq!(s.reconnect_attempts, 5);
        assert!(s.editor_overrides.is_empty());
        assert_eq!(
            s.sync_excludes,
            vec![".git", ".DS_Store", "node_modules", "Thumbs.db"]
        );
    }

    #[test]
    fn sync_excludes_are_trimmed_deduplicated_and_names_only() {
        let saved = IrisSettings {
            sync_excludes: vec![" *.tmp ".into(), "".into(), "*.tmp".into(), "build".into()],
            ..IrisSettings::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(saved.sync_excludes, vec!["*.tmp", "build"]);
        for bad in ["a/b", "a\\b"] {
            let err = IrisSettings {
                sync_excludes: vec![bad.into()],
                ..IrisSettings::default()
            }
            .normalized()
            .unwrap_err();
            assert_eq!(err.kind(), "invalidInput", "{bad}");
        }
        let too_many = IrisSettings {
            sync_excludes: (0..=MAX_SYNC_EXCLUDES).map(|i| format!("p{i}")).collect(),
            ..IrisSettings::default()
        };
        assert!(too_many.normalized().is_err());
    }

    #[test]
    fn a_file_without_sync_excludes_gets_the_defaults() {
        let partial: IrisSettings = serde_json::from_str(r#"{"parallelTransfers":2}"#).unwrap();
        assert_eq!(partial.sync_excludes, default_sync_excludes());
        let empty: IrisSettings = serde_json::from_str(r#"{"syncExcludes":[]}"#).unwrap();
        assert!(empty.sync_excludes.is_empty());
    }

    #[test]
    fn json_is_camel_case_and_round_trips() {
        let settings = IrisSettings {
            parallel_transfers: 8,
            reconnect_attempts: 0,
            editor_overrides: overrides(&[("md", "/Applications/Typora.app")]),
            sync_excludes: vec!["*.log".into()],
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(
            json.contains("\"syncExcludes\":[\"*.log\"]"),
            "json: {json}"
        );
        assert!(json.contains("\"parallelTransfers\":8"), "json: {json}");
        assert!(json.contains("\"reconnectAttempts\":0"), "json: {json}");
        assert!(json.contains("\"editorOverrides\""), "json: {json}");
        let back: IrisSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settings);
    }

    #[test]
    fn a_file_missing_newer_fields_still_loads() {
        let partial: IrisSettings = serde_json::from_str(r#"{"parallelTransfers":2}"#).unwrap();
        assert_eq!(partial.parallel_transfers, 2);
        assert_eq!(partial.reconnect_attempts, 5);
    }

    #[test]
    fn persists_across_reload() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");

        let store = IrisSettingsStore::new();
        store.set_path(file.clone());
        store
            .save(IrisSettings {
                parallel_transfers: 2,
                reconnect_attempts: 9,
                editor_overrides: overrides(&[("txt", "/usr/bin/nano")]),
                sync_excludes: vec!["dist".into()],
            })
            .unwrap();

        let reloaded = IrisSettingsStore::new();
        reloaded.set_path(file);
        let s = reloaded.get();
        assert_eq!(s.parallel_transfers, 2);
        assert_eq!(s.reconnect_attempts, 9);
        assert_eq!(s.editor_overrides, overrides(&[("txt", "/usr/bin/nano")]));
    }

    #[test]
    fn missing_file_is_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = IrisSettingsStore::new();
        store.set_path(dir.path().join("settings.json"));
        assert_eq!(store.get(), IrisSettings::default());
    }

    #[test]
    fn corrupt_file_is_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(&file, "not json").unwrap();

        let store = IrisSettingsStore::new();
        store.set_path(file);
        assert_eq!(store.get(), IrisSettings::default());
    }

    #[test]
    fn out_of_range_file_is_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        std::fs::write(&file, r#"{"parallelTransfers":0}"#).unwrap();

        let store = IrisSettingsStore::new();
        store.set_path(file);
        assert_eq!(store.get(), IrisSettings::default());
    }

    #[test]
    fn write_is_atomic_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        // A nested, not-yet-existing dir is created on first save.
        let file = dir.path().join("nested").join("settings.json");
        let store = IrisSettingsStore::new();
        store.set_path(file.clone());

        store
            .save(IrisSettings {
                parallel_transfers: 3,
                ..IrisSettings::default()
            })
            .unwrap();
        store
            .save(IrisSettings {
                parallel_transfers: 6,
                ..IrisSettings::default()
            })
            .unwrap();

        assert!(!file.with_extension("json.tmp").exists());
        let on_disk: IrisSettings =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(on_disk.parallel_transfers, 6);
        let entries: Vec<_> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("settings.json")]);
    }

    #[test]
    fn save_normalizes_editor_overrides() {
        let store = IrisSettingsStore::new();
        let saved = store
            .save(IrisSettings {
                editor_overrides: overrides(&[
                    ("  .MD ", "  /Applications/Typora.app  "),
                    ("txt", "   "),
                    ("  ", "/usr/bin/vim"),
                ]),
                ..IrisSettings::default()
            })
            .unwrap();
        assert_eq!(
            saved.editor_overrides,
            overrides(&[("md", "/Applications/Typora.app")])
        );
        assert_eq!(store.get(), saved);
    }

    #[test]
    fn save_rejects_out_of_range_values_and_keeps_the_old_ones() {
        let store = IrisSettingsStore::new();
        for bad in [
            IrisSettings {
                parallel_transfers: 0,
                ..IrisSettings::default()
            },
            IrisSettings {
                parallel_transfers: 17,
                ..IrisSettings::default()
            },
            IrisSettings {
                reconnect_attempts: 21,
                ..IrisSettings::default()
            },
        ] {
            assert!(matches!(store.save(bad), Err(CoreError::InvalidInput(_))));
        }
        assert_eq!(store.get(), IrisSettings::default());
    }

    #[test]
    fn in_memory_store_saves_without_a_path() {
        let store = IrisSettingsStore::new();
        let saved = store
            .save(IrisSettings {
                reconnect_attempts: 1,
                ..IrisSettings::default()
            })
            .unwrap();
        assert_eq!(store.get(), saved);
    }
}
