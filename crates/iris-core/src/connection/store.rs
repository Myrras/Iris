//! The saved connection profiles, persisted as `profiles.json` in the app
//! data dir.
//!
//! Same pattern as the settings store: writes are atomic (temp file +
//! rename), a missing file is an empty list, and until
//! [`ProfileStore::set_path`] is called the store is in-memory only. A
//! corrupt file is moved aside to `profiles.json.bak` (so a bad hand edit
//! does not silently lose every saved connection on the next save) and the
//! list starts empty.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::connection::ConnectionProfile;
use crate::error::{CoreError, CoreResult};
use crate::ids::ProfileId;
use crate::persist::write_json_atomic;

const LOCK_POISONED: &str = "profile store lock poisoned";

/// The persisted document. A wrapper object (not a bare array) so later
/// versions can add top-level fields. The array order **is** the order the
/// connections are shown in (see [`ProfileStore::reorder`]).
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProfilesFile {
    profiles: Vec<ConnectionProfile>,
}

struct Inner {
    path: Option<PathBuf>,
    profiles: Vec<ConnectionProfile>,
}

/// Thread-safe live copy of the saved profiles, shared by the
/// [`crate::Core`]. The order is the user's: new profiles go to the end,
/// [`ProfileStore::reorder`] moves them, saving or deleting never shuffles
/// the others.
pub struct ProfileStore {
    inner: Mutex<Inner>,
}

impl ProfileStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                path: None,
                profiles: Vec::new(),
            }),
        }
    }

    /// Point the store at its backing file and load whatever is there. Any
    /// in-memory profiles accumulated before this call are replaced.
    pub fn set_path(&self, path: PathBuf) {
        let profiles = load(&path);
        let mut inner = self.inner.lock().expect(LOCK_POISONED);
        inner.path = Some(path);
        inner.profiles = profiles;
    }

    /// All profiles in the user's order (never sorted).
    pub fn list(&self) -> Vec<ConnectionProfile> {
        self.inner.lock().expect(LOCK_POISONED).profiles.clone()
    }

    /// One profile by id.
    pub fn get(&self, id: ProfileId) -> CoreResult<ConnectionProfile> {
        self.inner
            .lock()
            .expect(LOCK_POISONED)
            .profiles
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("connection".into()))
    }

    /// Validate and insert or replace (by id) `profile`, then persist.
    /// Returns what was stored. On error nothing changes.
    pub fn save(&self, profile: ConnectionProfile) -> CoreResult<ConnectionProfile> {
        let profile = profile.normalized()?;
        let mut inner = self.inner.lock().expect(LOCK_POISONED);
        let mut next = inner.profiles.clone();
        match next.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile.clone(),
            None => next.push(profile.clone()),
        }
        persist(&inner, &next)?;
        inner.profiles = next;
        Ok(profile)
    }

    /// Put the profiles in the order of `ids`, then persist. `ids` must be a
    /// permutation of the current ids: an unknown, missing or repeated id is
    /// `InvalidInput` and nothing changes.
    pub fn reorder(&self, ids: &[ProfileId]) -> CoreResult<()> {
        let mut inner = self.inner.lock().expect(LOCK_POISONED);
        let mut seen = HashSet::new();
        if let Some(id) = ids.iter().find(|id| !seen.insert(**id)) {
            return Err(CoreError::InvalidInput(format!(
                "connection {id} is listed twice"
            )));
        }
        if let Some(id) = ids
            .iter()
            .find(|id| !inner.profiles.iter().any(|p| p.id == **id))
        {
            return Err(CoreError::InvalidInput(format!("unknown connection {id}")));
        }
        if ids.len() != inner.profiles.len() {
            return Err(CoreError::InvalidInput(
                "the list must name every saved connection".into(),
            ));
        }
        let next: Vec<ConnectionProfile> = ids
            .iter()
            .filter_map(|id| inner.profiles.iter().find(|p| p.id == *id).cloned())
            .collect();
        if next == inner.profiles {
            return Ok(());
        }
        persist(&inner, &next)?;
        inner.profiles = next;
        Ok(())
    }

    /// Remove a profile; `NotFound` when no profile has that id.
    pub fn delete(&self, id: ProfileId) -> CoreResult<()> {
        let mut inner = self.inner.lock().expect(LOCK_POISONED);
        let mut next = inner.profiles.clone();
        let before = next.len();
        next.retain(|p| p.id != id);
        if next.len() == before {
            return Err(CoreError::NotFound("connection".into()));
        }
        persist(&inner, &next)?;
        inner.profiles = next;
        Ok(())
    }
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self::new()
    }
}

fn persist(inner: &Inner, profiles: &[ConnectionProfile]) -> CoreResult<()> {
    let Some(path) = &inner.path else {
        return Ok(());
    };
    let doc = ProfilesFile {
        profiles: profiles.to_vec(),
    };
    write_json_atomic(path, &doc, "connection profiles")
}

/// Read the profiles from disk; a missing file is an empty list and a
/// corrupt one is moved aside first.
fn load(path: &Path) -> Vec<ConnectionProfile> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    // Hand-edited entries are re-validated like a save would; any invalid
    // one makes the whole file count as corrupt rather than half-trusted.
    let parsed = serde_json::from_str::<ProfilesFile>(&raw)
        .map_err(|e| e.to_string())
        .and_then(|doc| {
            doc.profiles
                .into_iter()
                .map(|p| p.normalized().map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>, _>>()
        });
    match parsed {
        Ok(profiles) => profiles,
        Err(e) => {
            tracing::warn!("profiles file is corrupt, starting empty: {e}");
            if let Err(e) = std::fs::rename(path, path.with_extension("json.bak")) {
                tracing::warn!("could not move the corrupt profiles file aside: {e}");
            }
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::AuthMethod;

    fn profile(name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: ProfileId::new(),
            name: name.into(),
            host: "sftp.example.test".into(),
            port: 2222,
            user: "demo".into(),
            auth: AuthMethod::KeyFile {
                path: "/home/demo/.ssh/id_ed25519".into(),
            },
            start_dir: Some("/srv/www".into()),
            jump: None,
        }
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        let store = ProfileStore::new();
        store.set_path(file.clone());
        let a = store.save(profile("A")).unwrap();
        let b = store.save(profile("B")).unwrap();

        let reloaded = ProfileStore::new();
        reloaded.set_path(file);
        assert_eq!(reloaded.list(), vec![a, b]);
    }

    #[test]
    fn save_with_a_known_id_replaces_in_place() {
        let store = ProfileStore::new();
        let a = store.save(profile("A")).unwrap();
        let b = store.save(profile("B")).unwrap();
        let renamed = store
            .save(ConnectionProfile {
                name: "A2".into(),
                ..a.clone()
            })
            .unwrap();
        assert_eq!(store.list(), vec![renamed, b]);
        assert_eq!(store.get(a.id).unwrap().name, "A2");
    }

    #[test]
    fn delete_removes_and_reports_unknown_ids() {
        let store = ProfileStore::new();
        let a = store.save(profile("A")).unwrap();
        store.delete(a.id).unwrap();
        assert!(store.list().is_empty());
        assert!(matches!(store.delete(a.id), Err(CoreError::NotFound(_))));
        assert!(matches!(store.get(a.id), Err(CoreError::NotFound(_))));
    }

    fn ids(store: &ProfileStore) -> Vec<ProfileId> {
        store.list().iter().map(|p| p.id).collect()
    }

    fn names(store: &ProfileStore) -> Vec<String> {
        store.list().into_iter().map(|p| p.name).collect()
    }

    #[test]
    fn new_profiles_go_to_the_end() {
        let store = ProfileStore::new();
        let a = store.save(profile("A")).unwrap();
        let b = store.save(profile("B")).unwrap();
        store.reorder(&[b.id, a.id]).unwrap();
        store.save(profile("C")).unwrap();
        assert_eq!(names(&store), ["B", "A", "C"]);
    }

    #[test]
    fn reorder_applies_and_survives_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        let store = ProfileStore::new();
        store.set_path(file.clone());
        let a = store.save(profile("A")).unwrap();
        let b = store.save(profile("B")).unwrap();
        let c = store.save(profile("C")).unwrap();
        store.reorder(&[c.id, a.id, b.id]).unwrap();
        assert_eq!(names(&store), ["C", "A", "B"]);

        let reloaded = ProfileStore::new();
        reloaded.set_path(file.clone());
        assert_eq!(reloaded.list(), vec![c, a, b]);
        assert!(!file.with_extension("json.tmp").exists());
    }

    #[test]
    fn reorder_refuses_anything_but_a_permutation() {
        let store = ProfileStore::new();
        let a = store.save(profile("A")).unwrap();
        let b = store.save(profile("B")).unwrap();
        let c = store.save(profile("C")).unwrap();
        let stranger = ProfileId::new();
        let bad: [&[ProfileId]; 6] = [
            &[a.id, b.id],                 // missing one
            &[a.id, b.id, c.id, c.id],     // too long
            &[a.id, a.id, b.id],           // duplicate
            &[a.id, b.id, stranger],       // unknown
            &[a.id, b.id, c.id, stranger], // unknown extra
            &[],                           // nothing
        ];
        for list in bad {
            assert!(
                matches!(store.reorder(list), Err(CoreError::InvalidInput(_))),
                "{list:?}"
            );
        }
        assert_eq!(names(&store), ["A", "B", "C"]);
        assert!(matches!(
            ProfileStore::new().reorder(&[a.id]),
            Err(CoreError::InvalidInput(_))
        ));
        ProfileStore::new().reorder(&[]).unwrap();
    }

    #[test]
    fn a_refused_reorder_leaves_the_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        let store = ProfileStore::new();
        store.set_path(file.clone());
        let a = store.save(profile("A")).unwrap();
        store.save(profile("B")).unwrap();
        let before = std::fs::read_to_string(&file).unwrap();
        assert!(store.reorder(&[a.id, a.id]).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
    }

    #[test]
    fn saving_an_edited_profile_keeps_its_position() {
        let store = ProfileStore::new();
        let a = store.save(profile("A")).unwrap();
        let b = store.save(profile("B")).unwrap();
        let c = store.save(profile("C")).unwrap();
        store.reorder(&[c.id, a.id, b.id]).unwrap();
        store
            .save(ConnectionProfile {
                name: "A2".into(),
                ..a
            })
            .unwrap();
        assert_eq!(names(&store), ["C", "A2", "B"]);
        assert_eq!(ids(&store), [c.id, a.id, b.id]);
    }

    #[test]
    fn delete_keeps_the_order_of_the_others() {
        let store = ProfileStore::new();
        let a = store.save(profile("A")).unwrap();
        let b = store.save(profile("B")).unwrap();
        let c = store.save(profile("C")).unwrap();
        let d = store.save(profile("D")).unwrap();
        store.reorder(&[d.id, b.id, c.id, a.id]).unwrap();
        store.delete(c.id).unwrap();
        assert_eq!(ids(&store), [d.id, b.id, a.id]);
        // The shorter list is now the whole permutation.
        store.reorder(&[a.id, d.id, b.id]).unwrap();
        assert_eq!(names(&store), ["A", "D", "B"]);
    }

    #[test]
    fn a_file_without_any_reorder_loads_in_its_array_order() {
        // Files written before reordering existed are plain arrays in the
        // order they were created: that order stays.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        let store = ProfileStore::new();
        store.set_path(file.clone());
        store.save(profile("A")).unwrap();
        store.save(profile("B")).unwrap();
        store.save(profile("C")).unwrap();
        let reloaded = ProfileStore::new();
        reloaded.set_path(file);
        assert_eq!(names(&reloaded), ["A", "B", "C"]);
    }

    #[test]
    fn invalid_profiles_are_rejected_and_change_nothing() {
        let store = ProfileStore::new();
        let bad = ConnectionProfile {
            host: "".into(),
            ..profile("A")
        };
        assert!(matches!(store.save(bad), Err(CoreError::InvalidInput(_))));
        assert!(store.list().is_empty());
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new();
        store.set_path(dir.path().join("profiles.json"));
        assert!(store.list().is_empty());
    }

    #[test]
    fn corrupt_file_is_empty_and_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        std::fs::write(&file, "not json").unwrap();
        let store = ProfileStore::new();
        store.set_path(file.clone());
        assert!(store.list().is_empty());
        assert_eq!(
            std::fs::read_to_string(file.with_extension("json.bak")).unwrap(),
            "not json"
        );
    }

    #[test]
    fn the_file_never_contains_secret_fields() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profiles.json");
        let store = ProfileStore::new();
        store.set_path(file.clone());
        store.save(profile("A")).unwrap();
        store
            .save(ConnectionProfile {
                auth: AuthMethod::Password,
                ..profile("B")
            })
            .unwrap();
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(!raw.contains("\"password\":"), "{raw}");
        assert!(!raw.contains("passphrase"), "{raw}");
        assert!(!file.with_extension("json.tmp").exists());
    }
}
