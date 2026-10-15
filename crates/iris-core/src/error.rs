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
    fn invalid_input_carries_its_message() {
        let err = CoreError::InvalidInput("must be positive".into());
        assert_eq!(err.to_string(), "invalid input: must be positive");
    }
}
