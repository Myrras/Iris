//! A credential wrapper that never leaks its contents through `Debug`,
//! `Display`, serialization or logging, and zeroes its memory on drop.
//!
//! Passwords and key passphrases are kept out of
//! [`ConnectionProfile`](crate::connection::ConnectionProfile) entirely: in
//! Phase 1 they are prompted per connect, travel into [`crate::Core::connect`]
//! as a `Secret`, and are dropped (wiped) once authentication is done.

use zeroize::Zeroize;

/// An opaque secret string (password / passphrase).
///
/// `Secret` deliberately does not implement `serde::Serialize`, and its
/// `Debug`/`Display` output is redacted, so it cannot accidentally end up in a
/// log line, error message or persisted file. It does implement
/// `Deserialize`, so the shell can receive it straight from an IPC argument.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    /// Wrap a secret value.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrow the raw secret. Call this only at the point of use (handing it
    /// to the SSH library); never store, log or format the result.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Whether the secret is empty (e.g. an unset password).
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl<'de> serde::Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let s = Secret::new("hunter2");
        assert_eq!(format!("{s:?}"), "Secret(***)");
        assert!(!format!("{s:?}").contains("hunter2"));
    }

    #[test]
    fn display_is_redacted() {
        let s = Secret::new("hunter2");
        assert_eq!(s.to_string(), "***");
        assert_eq!(format!("{s}"), "***");
    }

    #[test]
    fn redacted_inside_containers_too() {
        let wrapped = Some(Secret::new("hunter2"));
        assert!(!format!("{wrapped:?}").contains("hunter2"));
    }

    #[test]
    fn expose_returns_value() {
        let s = Secret::new("hunter2");
        assert_eq!(s.expose(), "hunter2");
        assert!(!s.is_empty());
        assert!(Secret::new("").is_empty());
    }

    #[test]
    fn deserializes_from_a_plain_string() {
        let s: Secret = serde_json::from_str("\"hunter2\"").unwrap();
        assert_eq!(s.expose(), "hunter2");
    }
}
