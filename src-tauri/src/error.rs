//! The IPC-facing error type.
//!
//! Every command returns `Result<T, IpcError>`. `IpcError` is a flat,
//! serializable shape so the frontend can branch on a stable `kind` string and
//! show the (already-sanitized) `message`. Messages come from
//! [`CoreError`](iris_core::CoreError)'s `Display` (app-owned text) or from
//! IPC-layer validation here — never from secrets.

use serde::Serialize;

use iris_core::CoreError;

/// A flat, serializable error returned by every IPC command.
///
/// `kind` is a stable machine-readable category (camelCase, matching the
/// [`CoreError`] variant, plus a few IPC-only kinds); `message` is a
/// human-readable, secret-free description.
#[derive(Debug, Clone, Serialize)]
pub struct IpcError {
    /// Human-readable, sanitized description (never contains secrets).
    pub message: String,
    /// Stable machine-readable category.
    pub kind: String,
}

impl IpcError {
    /// Build an `IpcError` from a `kind` discriminant and a (secret-free)
    /// message. Used for IPC-layer conditions that have no [`CoreError`]
    /// counterpart.
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }

    /// Invalid command input detected at the IPC layer.
    // Part of the documented IPC contract (CLAUDE.md); Phase 0's commands
    // validate in the core, so the first IPC-layer caller arrives later.
    #[allow(dead_code)]
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("invalidInput", message)
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.kind)
    }
}

impl std::error::Error for IpcError {}

impl From<std::io::Error> for IpcError {
    fn from(err: std::io::Error) -> Self {
        Self::new("io", err.to_string())
    }
}

impl From<CoreError> for IpcError {
    fn from(err: CoreError) -> Self {
        // The `message` is `CoreError`'s own `Display`, which is built from
        // app-owned text only — safe to forward verbatim. The `kind` comes
        // from the core so the mapping lives next to the variants.
        Self {
            kind: err.kind().to_string(),
            message: err.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_errors_map_to_stable_kinds() {
        let cases = [
            (CoreError::Io(std::io::Error::other("x")), "io"),
            (CoreError::Config("x".into()), "config"),
            (CoreError::InvalidInput("x".into()), "invalidInput"),
            (CoreError::NotFound("/x".into()), "notFound"),
            (CoreError::AlreadyExists("/x".into()), "alreadyExists"),
            (CoreError::PermissionDenied("/x".into()), "permissionDenied"),
            (CoreError::ConnectFailed("x".into()), "connectFailed"),
            (CoreError::AuthFailed, "authFailed"),
            (CoreError::PasswordRequired, "passwordRequired"),
            (CoreError::PassphraseRequired, "passphraseRequired"),
            (CoreError::KeyFile("x".into()), "keyFile"),
            (CoreError::Agent("x".into()), "agent"),
            (CoreError::Keychain("x".into()), "keychain"),
            (CoreError::JumpHost("x".into()), "jumpHost"),
            (
                CoreError::HostKeyChanged {
                    host: "sftp.example.test".into(),
                    port: 22,
                },
                "hostKeyChanged",
            ),
            (CoreError::HostKeyRejected, "hostKeyRejected"),
            (CoreError::NotConnected, "notConnected"),
            (CoreError::Remote("x".into()), "remote"),
            (CoreError::NoAnswer, "remote"),
            (CoreError::TooLarge("x".into()), "tooLarge"),
            (CoreError::Cancelled, "cancelled"),
        ];
        for (err, kind) in cases {
            let message = err.to_string();
            let ipc = IpcError::from(err);
            assert_eq!(ipc.kind, kind);
            assert_eq!(ipc.message, message);
        }
    }

    #[test]
    fn serializes_as_kind_and_message() {
        let json = serde_json::to_value(IpcError::invalid_input("bad")).unwrap();
        assert_eq!(json["kind"], "invalidInput");
        assert_eq!(json["message"], "bad");
    }
}
