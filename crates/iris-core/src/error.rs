//! Error types shared across iris-core.

use thiserror::Error;

/// Convenience alias used by all fallible core APIs.
pub type CoreResult<T> = Result<T, CoreError>;

/// All errors surfaced by the iris-core public API.
///
/// Variant `Display` text is app-owned and safe to forward to the UI: it never
/// contains secrets, file contents or remote output verbatim. The shell maps
/// each variant to a stable camelCase `kind` (see `src-tauri/src/error.rs`).
#[derive(Debug, Error)]
pub enum CoreError {
    /// A local filesystem operation failed (e.g. writing `settings.json`).
    /// `std::io::Error`'s own text is an OS error description, never file
    /// contents.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// A persisted document could not be encoded or decoded; Iris-owned text.
    #[error("config error: {0}")]
    Config(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// A file, folder or saved connection does not exist. Carries what was
    /// looked up (a path or "connection"), never contents.
    #[error("not found: {0}")]
    NotFound(String),

    /// The OS or the remote server refused access to a path.
    #[error("permission denied: {0}")]
    PermissionDenied(String),

    /// The TCP connection or the SSH handshake failed (refused, unreachable,
    /// timed out, protocol error). Iris-owned text.
    #[error("could not connect: {0}")]
    ConnectFailed(String),

    /// The server refused the password or key.
    #[error("authentication failed")]
    AuthFailed,

    /// A password profile was connected without a password, and none is
    /// remembered in the keychain; the UI prompts for one and retries.
    #[error("a password is required")]
    PasswordRequired,

    /// The key file is encrypted and no passphrase was given; the UI prompts
    /// for one and retries.
    #[error("the key file is encrypted; a passphrase is required")]
    PassphraseRequired,

    /// The key file could not be read or decoded (missing, unsupported
    /// format, wrong passphrase). Iris-owned text, never key material.
    #[error("key file: {0}")]
    KeyFile(String),

    /// The SSH agent could not be used (none running, no keys, refused to
    /// sign). Iris-owned text.
    #[error("ssh agent: {0}")]
    Agent(String),

    /// The OS keychain could not store, read or delete a remembered secret.
    /// Iris-owned text; never the secret.
    #[error("keychain: {0}")]
    Keychain(String),

    /// Reaching the target through its jump host failed (the jump host
    /// refused the login, or could not reach the target). Iris-owned text
    /// that names the jump host.
    #[error("jump host: {0}")]
    JumpHost(String),

    /// The server presented a different key than `known_hosts` records for
    /// it. A hard stop: there is deliberately no override path.
    #[error(
        "the host key for {host}:{port} has changed; this can mean someone is intercepting the \
         connection, so Iris refused to connect"
    )]
    HostKeyChanged { host: String, port: u16 },

    /// The user declined (or did not answer) the unknown-host-key prompt.
    #[error("the host key was not trusted")]
    HostKeyRejected,

    /// The session does not exist (any more): never opened, disconnected,
    /// or the connection dropped.
    #[error("not connected")]
    NotConnected,

    /// Any other failure reported by the remote side, described by Iris
    /// (the server's own message text is never forwarded).
    #[error("remote error: {0}")]
    Remote(String),
}

impl CoreError {
    /// Stable camelCase category for this error, used as the IPC `kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Io(_) => "io",
            Self::Config(_) => "config",
            Self::InvalidInput(_) => "invalidInput",
            Self::NotFound(_) => "notFound",
            Self::PermissionDenied(_) => "permissionDenied",
            Self::ConnectFailed(_) => "connectFailed",
            Self::AuthFailed => "authFailed",
            Self::PasswordRequired => "passwordRequired",
            Self::PassphraseRequired => "passphraseRequired",
            Self::KeyFile(_) => "keyFile",
            Self::Agent(_) => "agent",
            Self::Keychain(_) => "keychain",
            Self::JumpHost(_) => "jumpHost",
            Self::HostKeyChanged { .. } => "hostKeyChanged",
            Self::HostKeyRejected => "hostKeyRejected",
            Self::NotConnected => "notConnected",
            Self::Remote(_) => "remote",
        }
    }

    /// Classify a local `std::io::Error` for `path`: missing and forbidden
    /// paths get their own kinds so the UI can branch on them.
    pub fn from_io_at(err: std::io::Error, path: &str) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound(path.to_string()),
            std::io::ErrorKind::PermissionDenied => Self::PermissionDenied(path.to_string()),
            _ => Self::Io(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_convert_and_keep_an_app_owned_prefix() {
        let err: CoreError = std::io::Error::other("disk full").into();
        assert!(matches!(err, CoreError::Io(_)));
        assert_eq!(err.to_string(), "io error: disk full");
    }

    #[test]
    fn every_variant_has_a_camel_case_kind() {
        let cases = [
            (CoreError::Io(std::io::Error::other("x")), "io"),
            (CoreError::Config("x".into()), "config"),
            (CoreError::InvalidInput("x".into()), "invalidInput"),
            (CoreError::NotFound("/x".into()), "notFound"),
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
                    host: "example.test".into(),
                    port: 22,
                },
                "hostKeyChanged",
            ),
            (CoreError::HostKeyRejected, "hostKeyRejected"),
            (CoreError::NotConnected, "notConnected"),
            (CoreError::Remote("x".into()), "remote"),
        ];
        for (err, kind) in cases {
            assert_eq!(err.kind(), kind);
        }
    }

    #[test]
    fn host_key_changed_names_the_host() {
        let err = CoreError::HostKeyChanged {
            host: "example.test".into(),
            port: 2222,
        };
        assert!(err.to_string().contains("example.test:2222"));
    }

    #[test]
    fn io_errors_at_a_path_are_classified() {
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(matches!(
            CoreError::from_io_at(missing, "/a"),
            CoreError::NotFound(p) if p == "/a"
        ));
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(matches!(
            CoreError::from_io_at(denied, "/b"),
            CoreError::PermissionDenied(_)
        ));
        let other = std::io::Error::other("boom");
        assert!(matches!(
            CoreError::from_io_at(other, "/c"),
            CoreError::Io(_)
        ));
    }

    #[test]
    fn invalid_input_carries_its_message() {
        let err = CoreError::InvalidInput("must be positive".into());
        assert_eq!(err.to_string(), "invalid input: must be positive");
    }
}
