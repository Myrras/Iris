//! Remembered passwords and key passphrases, kept in the OS keychain.
//!
//! A secret is only ever stored here, never in a profile, settings file, log
//! line, event or error. Entries are filed under the service [`SERVICE`]
//! (`iris`) with the account `<profileId>/password` or
//! `<profileId>/passphrase`, i.e. the key `iris/<profileId>/<kind>`.
//!
//! [`SecretStore`] is the seam: [`KeychainStore`] talks to the platform
//! credential store through `keyring` (Keychain on macOS, Credential Manager
//! on Windows, the Secret Service on Linux), and [`MemorySecretStore`] keeps
//! them in memory. The [`crate::Core`] starts with the in-memory store, so
//! tests never touch the real keychain; the shell swaps in the keychain.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::ids::ProfileId;
use crate::secret::Secret;

/// The keychain service every Iris secret is filed under.
pub const SERVICE: &str = "iris";

/// Which secret of a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretKind {
    /// The login password of a password profile.
    Password,
    /// The passphrase of a profile's encrypted private key file.
    Passphrase,
}

impl SecretKind {
    pub const ALL: [SecretKind; 2] = [SecretKind::Password, SecretKind::Passphrase];

    fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Passphrase => "passphrase",
        }
    }
}

/// The keychain account of one secret: `<profileId>/<kind>`.
pub fn account(profile_id: ProfileId, kind: SecretKind) -> String {
    format!("{profile_id}/{}", kind.as_str())
}

/// Where remembered secrets live. A missing entry is `Ok(None)` on read and
/// a no-op on delete, never an error.
pub trait SecretStore: Send + Sync {
    fn get(&self, profile_id: ProfileId, kind: SecretKind) -> CoreResult<Option<Secret>>;
    fn set(&self, profile_id: ProfileId, kind: SecretKind, value: &Secret) -> CoreResult<()>;
    fn delete(&self, profile_id: ProfileId, kind: SecretKind) -> CoreResult<()>;
}

/// The OS keychain via `keyring`. Stateless: each call opens its entry.
#[derive(Debug, Default, Clone, Copy)]
pub struct KeychainStore;

impl KeychainStore {
    pub fn new() -> Self {
        Self
    }
}

fn entry(profile_id: ProfileId, kind: SecretKind) -> CoreResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &account(profile_id, kind)).map_err(|e| keychain_error("open", e))
}

/// Iris-owned text for a keychain failure. `keyring`'s own description
/// never holds the secret, but it can carry platform detail, so it is only
/// logged at debug level.
fn keychain_error(op: &str, err: keyring::Error) -> CoreError {
    tracing::debug!("keychain {op} failed: {err}");
    CoreError::Keychain(format!("could not {op} the saved secret"))
}

impl SecretStore for KeychainStore {
    fn get(&self, profile_id: ProfileId, kind: SecretKind) -> CoreResult<Option<Secret>> {
        match entry(profile_id, kind)?.get_password() {
            Ok(value) => Ok(Some(Secret::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error("read", e)),
        }
    }

    fn set(&self, profile_id: ProfileId, kind: SecretKind, value: &Secret) -> CoreResult<()> {
        entry(profile_id, kind)?
            .set_password(value.expose())
            .map_err(|e| keychain_error("store", e))
    }

    fn delete(&self, profile_id: ProfileId, kind: SecretKind) -> CoreResult<()> {
        match entry(profile_id, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error("delete", e)),
        }
    }
}

/// An in-memory store: the default until the shell installs the keychain,
/// and the fake the tests use.
#[derive(Default)]
pub struct MemorySecretStore {
    entries: Mutex<HashMap<(ProfileId, SecretKind), Secret>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

const LOCK_POISONED: &str = "secret store lock poisoned";

impl SecretStore for MemorySecretStore {
    fn get(&self, profile_id: ProfileId, kind: SecretKind) -> CoreResult<Option<Secret>> {
        Ok(self
            .entries
            .lock()
            .expect(LOCK_POISONED)
            .get(&(profile_id, kind))
            .cloned())
    }

    fn set(&self, profile_id: ProfileId, kind: SecretKind, value: &Secret) -> CoreResult<()> {
        self.entries
            .lock()
            .expect(LOCK_POISONED)
            .insert((profile_id, kind), value.clone());
        Ok(())
    }

    fn delete(&self, profile_id: ProfileId, kind: SecretKind) -> CoreResult<()> {
        self.entries
            .lock()
            .expect(LOCK_POISONED)
            .remove(&(profile_id, kind));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_are_profile_and_kind() {
        let id = ProfileId::new();
        assert_eq!(account(id, SecretKind::Password), format!("{id}/password"));
        assert_eq!(
            account(id, SecretKind::Passphrase),
            format!("{id}/passphrase")
        );
    }

    #[test]
    fn kinds_are_camel_case_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&SecretKind::Passphrase).unwrap(),
            "\"passphrase\""
        );
        let kind: SecretKind = serde_json::from_str("\"password\"").unwrap();
        assert_eq!(kind, SecretKind::Password);
    }

    #[test]
    fn memory_store_round_trips_per_profile_and_kind() {
        let store = MemorySecretStore::new();
        let a = ProfileId::new();
        let b = ProfileId::new();
        assert!(store.get(a, SecretKind::Password).unwrap().is_none());
        store
            .set(a, SecretKind::Password, &Secret::new("example-one"))
            .unwrap();
        store
            .set(b, SecretKind::Password, &Secret::new("example-two"))
            .unwrap();
        let got = store.get(a, SecretKind::Password).unwrap().unwrap();
        assert_eq!(got.expose(), "example-one");
        assert!(store.get(a, SecretKind::Passphrase).unwrap().is_none());
        store.delete(a, SecretKind::Password).unwrap();
        assert!(store.get(a, SecretKind::Password).unwrap().is_none());
        // Deleting what is not there is fine.
        store.delete(a, SecretKind::Password).unwrap();
        assert!(store.get(b, SecretKind::Password).unwrap().is_some());
    }

    #[test]
    fn keychain_errors_are_app_owned_text() {
        let err = keychain_error("read", keyring::Error::NoStorageAccess("x".into()));
        assert_eq!(err.kind(), "keychain");
        assert_eq!(err.to_string(), "keychain: could not read the saved secret");
    }

    /// A real round trip against the OS keychain. Ignored so `cargo test`
    /// stays hermetic; run by hand with
    /// `cargo test -p iris-core --lib -- --ignored live_keychain_round_trip`.
    #[test]
    #[ignore = "touches the real OS keychain; run manually"]
    fn live_keychain_round_trip() {
        let store = KeychainStore::new();
        let id = ProfileId::new();
        store
            .set(id, SecretKind::Password, &Secret::new("example-secret"))
            .unwrap();
        let got = store.get(id, SecretKind::Password).unwrap().unwrap();
        assert_eq!(got.expose(), "example-secret");
        store.delete(id, SecretKind::Password).unwrap();
        assert!(store.get(id, SecretKind::Password).unwrap().is_none());
        store.delete(id, SecretKind::Password).unwrap();
    }
}
