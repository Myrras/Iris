//! One authenticated SSH connection with an SFTP channel on top.
//!
//! Everything russh-specific about connecting lives here (and in
//! `hostkey.rs`); callers only see [`SshSession`], [`ConnectRequest`] and
//! [`CoreError`]s.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, AuthResult, DisconnectReason};
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::Disconnect;
use russh_sftp::client::SftpSession;

use crate::connection::AuthMethod;
use crate::error::{CoreError, CoreResult};
use crate::events::EventBus;
use crate::fs::SftpFs;
use crate::ids::SessionId;
use crate::secret::Secret;
use crate::ssh::hostkey::{self, HostKeyPrompts};

/// Upper bound for TCP connect + SSH handshake (not counting the time a host
/// key prompt waits for the user, which has its own timeout).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

/// Called once when an established connection ends for any reason, with an
/// Iris-owned description.
pub type OnClosed = Box<dyn FnOnce(String) + Send + Sync>;

/// Everything needed to open one session.
pub struct ConnectRequest {
    pub session_id: SessionId,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub password: Option<Secret>,
    pub passphrase: Option<Secret>,
    pub known_hosts: PathBuf,
    pub prompts: Arc<HostKeyPrompts>,
    pub events: EventBus,
    pub on_closed: OnClosed,
}

/// A live, authenticated SSH session with its SFTP channel.
pub struct SshSession {
    handle: client::Handle<ClientHandler>,
    fs: SftpFs,
}

impl SshSession {
    /// Connect, verify the host key, authenticate and open SFTP.
    pub async fn connect(req: ConnectRequest) -> CoreResult<Self> {
        let config = Arc::new(client::Config {
            nodelay: true,
            // Notice dead connections instead of hanging on them.
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            ..client::Config::default()
        });
        let handler = ClientHandler {
            host: req.host.clone(),
            port: req.port,
            session_id: req.session_id,
            known_hosts: req.known_hosts,
            prompts: req.prompts,
            events: req.events,
            on_closed: Some(req.on_closed),
        };

        let connecting = client::connect(config, (req.host.as_str(), req.port), handler);
        let mut handle = match tokio::time::timeout(HANDSHAKE_TIMEOUT, connecting).await {
            Ok(Ok(handle)) => handle,
            Ok(Err(HandlerError::HostKey(e))) => return Err(e),
            Ok(Err(HandlerError::Ssh(e))) => return Err(map_connect_error(e)),
            Err(_) => return Err(CoreError::ConnectFailed("timed out".into())),
        };

        authenticate(
            &mut handle,
            &req.user,
            &req.auth,
            req.password,
            req.passphrase,
        )
        .await?;

        let sftp = open_sftp(&handle).await?;
        Ok(Self {
            handle,
            fs: SftpFs::new(sftp),
        })
    }

    /// The SFTP filesystem of this session.
    pub fn fs(&self) -> &SftpFs {
        &self.fs
    }

    /// Close SFTP and the SSH connection (best effort).
    pub async fn disconnect(&self) {
        self.fs.close().await;
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
}

async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    auth: &AuthMethod,
    password: Option<Secret>,
    passphrase: Option<Secret>,
) -> CoreResult<()> {
    let result = match auth {
        AuthMethod::Password => {
            let password =
                password.ok_or_else(|| CoreError::InvalidInput("a password is required".into()))?;
            handle
                .authenticate_password(user, password.expose())
                .await
                .map_err(map_connect_error)?
        }
        AuthMethod::KeyFile { path } => {
            let key = load_key(path, passphrase.as_ref()).await?;
            // RSA keys need the server's preferred signature hash; other
            // key types ignore it.
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(map_connect_error)?
        }
    };
    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(CoreError::AuthFailed),
    }
}

/// Read and decode a private key at connect time. The file text is held in a
/// [`Secret`] so it is wiped as soon as decoding is done; nothing is cached.
async fn load_key(path: &str, passphrase: Option<&Secret>) -> CoreResult<russh::keys::PrivateKey> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .map(Secret::from)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => CoreError::KeyFile("the file does not exist".into()),
            _ => CoreError::KeyFile("the file could not be read".into()),
        })?;
    match decode_secret_key(raw.expose(), passphrase.map(Secret::expose)) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(CoreError::PassphraseRequired),
        Err(e) => {
            tracing::debug!("could not decode the key file: {e}");
            // With a passphrase given, tell a wrong passphrase apart from an
            // unusable file: the latter fails the same way without one.
            let encrypted = passphrase.is_some()
                && matches!(
                    decode_secret_key(raw.expose(), None),
                    Err(russh::keys::Error::KeyIsEncrypted)
                );
            Err(CoreError::KeyFile(if encrypted {
                "wrong passphrase".into()
            } else {
                "unsupported or damaged key file".into()
            }))
        }
    }
}

async fn open_sftp(handle: &client::Handle<ClientHandler>) -> CoreResult<SftpSession> {
    let failed = |e: &dyn std::fmt::Display| {
        tracing::debug!("could not start SFTP: {e}");
        CoreError::Remote("could not start SFTP on the server".into())
    };
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| failed(&e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| failed(&e))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| failed(&e))
}

/// Iris-owned text for a failed connect. The OS description of an I/O error
/// (e.g. "Connection refused") is safe to show; protocol details are only
/// logged at debug level.
fn map_connect_error(err: russh::Error) -> CoreError {
    match err {
        russh::Error::IO(e) => CoreError::ConnectFailed(match e.kind() {
            std::io::ErrorKind::ConnectionRefused => "connection refused".into(),
            std::io::ErrorKind::TimedOut => "timed out".into(),
            _ => e.to_string(),
        }),
        russh::Error::UnknownKey => CoreError::HostKeyRejected,
        russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout => {
            CoreError::ConnectFailed("timed out".into())
        }
        other => {
            tracing::debug!("SSH handshake failed: {other}");
            CoreError::ConnectFailed("the SSH handshake failed".into())
        }
    }
}

/// russh's per-connection callbacks.
struct ClientHandler {
    host: String,
    port: u16,
    session_id: SessionId,
    known_hosts: PathBuf,
    prompts: Arc<HostKeyPrompts>,
    events: EventBus,
    on_closed: Option<OnClosed>,
}

/// The handler's error: either russh's own, or a host key verdict that must
/// reach the caller as its exact [`CoreError`].
#[derive(Debug)]
enum HandlerError {
    Ssh(russh::Error),
    HostKey(CoreError),
}

impl From<russh::Error> for HandlerError {
    fn from(e: russh::Error) -> Self {
        Self::Ssh(e)
    }
}

impl client::Handler for ClientHandler {
    type Error = HandlerError;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // A host certificate is checked by the key it certifies (no CA
        // support yet), exactly like a plain host key.
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        hostkey::verify(
            &self.known_hosts,
            &self.prompts,
            &self.events,
            self.session_id,
            &self.host,
            self.port,
            &key,
        )
        .await
        .map(|()| true)
        .map_err(HandlerError::HostKey)
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let (text, result) = match reason {
            DisconnectReason::ReceivedDisconnect(_) => ("the server closed the connection", Ok(())),
            DisconnectReason::Error(e) => ("the connection was lost", Err(e)),
        };
        if let Some(on_closed) = self.on_closed.take() {
            on_closed(text.to_string());
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refused_connections_are_connect_failed() {
        let err = map_connect_error(russh::Error::IO(std::io::Error::from(
            std::io::ErrorKind::ConnectionRefused,
        )));
        assert_eq!(err.kind(), "connectFailed");
        assert_eq!(err.to_string(), "could not connect: connection refused");
    }

    #[test]
    fn protocol_errors_get_generic_text() {
        let err = map_connect_error(russh::Error::Inconsistent);
        assert_eq!(err.kind(), "connectFailed");
        assert_eq!(
            err.to_string(),
            "could not connect: the SSH handshake failed"
        );
    }

    #[tokio::test]
    async fn missing_key_files_are_key_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("id_missing");
        let err = load_key(&missing.to_string_lossy(), None)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "keyFile");
    }

    #[tokio::test]
    async fn garbage_key_files_are_key_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("id_garbage");
        std::fs::write(&file, "this is not a key").unwrap();
        let err = load_key(&file.to_string_lossy(), None).await.unwrap_err();
        assert_eq!(err.kind(), "keyFile");
    }
}
