//! One authenticated SSH connection with an SFTP channel on top, reached
//! directly or through jump hosts.
//!
//! Everything russh-specific about connecting lives here (and in
//! `hostkey.rs` / `agent.rs`); callers only see [`SshSession`],
//! [`ConnectRequest`] and [`CoreError`]s.
//!
//! A connect walks its [`Hop`]s in order: the first over TCP, every next one
//! over a `direct-tcpip` channel opened on the previous hop's connection.
//! Each hop does its own host key check and login; the jump connections are
//! kept for as long as the session lives.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, AuthResult, DisconnectReason};
use russh::keys::agent::AgentIdentity;
use russh::keys::{
    decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate,
};
use russh::Disconnect;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::connection::route::{Hop, HopAuth};
use crate::error::{CoreError, CoreResult};
use crate::events::EventBus;
use crate::fs::SftpFs;
use crate::ids::SessionId;
use crate::secret::Secret;
use crate::ssh::agent::{self, AgentLocation};
use crate::ssh::hostkey::{self, HostKeyPrompts};

/// Upper bound for TCP connect + SSH handshake of one hop (not counting the
/// time a host key prompt waits for the user, which has its own timeout).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

/// A keepalive goes out after this long without traffic from the server…
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// …and the connection counts as dead after this many go unanswered, so a
/// link that died silently (sleep, Wi-Fi switch, NAT timeout) is noticed in
/// about half a minute and the reconnect can start, instead of hanging until
/// TCP gives up.
const KEEPALIVE_MAX: usize = 3;

/// How long [`SshSession::probe`] waits for the server to answer a ping.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Called once when an established connection ends for any reason, with an
/// Iris-owned description.
pub type OnClosed = Box<dyn FnOnce(String) + Send + Sync>;

/// The session's [`OnClosed`], shared by every hop's handler: whichever
/// connection ends first (the target, or a jump host it runs through)
/// reports it, once.
type SharedOnClosed = Arc<std::sync::Mutex<Option<OnClosed>>>;

/// One hop and the secrets it may use.
pub struct HopRequest {
    pub hop: Hop,
    pub password: Option<Secret>,
    pub passphrase: Option<Secret>,
}

/// Everything needed to open one session.
pub struct ConnectRequest {
    pub session_id: SessionId,
    /// Jump hosts first, the target last; never empty.
    pub hops: Vec<HopRequest>,
    /// Where the SSH agent is; `None` = no agent.
    pub agent: Option<AgentLocation>,
    pub known_hosts: PathBuf,
    /// Where an unknown host key is asked about; `None` refuses it instead
    /// (an automatic reconnect, which nobody is watching).
    pub prompts: Option<Arc<HostKeyPrompts>>,
    pub events: EventBus,
    pub on_closed: OnClosed,
}

type Handle = client::Handle<ClientHandler>;

/// A live, authenticated SSH session with its SFTP channel.
pub struct SshSession {
    handle: Handle,
    /// The jump connections the session runs through, outermost first.
    jumps: Vec<Handle>,
    fs: SftpFs,
}

impl SshSession {
    /// Connect every hop (verifying its host key and logging in), then open
    /// SFTP on the target.
    pub async fn connect(req: ConnectRequest) -> CoreResult<Self> {
        let ConnectRequest {
            session_id,
            hops,
            agent,
            known_hosts,
            prompts,
            events,
            on_closed,
        } = req;
        let config = Arc::new(client::Config {
            nodelay: true,
            // Notice dead connections instead of hanging on them.
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: KEEPALIVE_MAX,
            ..client::Config::default()
        });
        let target_index = hops
            .len()
            .checked_sub(1)
            .ok_or_else(|| CoreError::InvalidInput("there is nothing to connect to".into()))?;
        let on_closed: SharedOnClosed = Arc::new(std::sync::Mutex::new(Some(on_closed)));
        let mut jumps: Vec<(Handle, String)> = Vec::new();

        for (index, request) in hops.into_iter().enumerate() {
            let is_target = index == target_index;
            let HopRequest {
                hop,
                password,
                passphrase,
            } = request;
            let handler = ClientHandler {
                host: hop.host.clone(),
                port: hop.port,
                session_id,
                known_hosts: known_hosts.clone(),
                prompts: prompts.clone(),
                events: events.clone(),
                is_jump: !is_target,
                on_closed: Arc::clone(&on_closed),
            };
            let connected = async {
                let mut handle = match jumps.last() {
                    None => {
                        let stream = tcp_connect(&hop).await?;
                        handshake(Arc::clone(&config), stream, handler).await?
                    }
                    Some((via, via_label)) => {
                        let stream = open_tunnel(via, via_label, &hop).await?;
                        handshake(Arc::clone(&config), stream, handler).await?
                    }
                };
                authenticate(&mut handle, &hop, password, passphrase, agent.as_ref()).await?;
                Ok::<_, CoreError>(handle)
            }
            .await;
            match connected {
                Ok(handle) if is_target => {
                    let jumps: Vec<Handle> = jumps.into_iter().map(|(h, _)| h).collect();
                    let sftp = match open_sftp(&handle).await {
                        Ok(sftp) => sftp,
                        Err(e) => {
                            close_all(&handle, &jumps).await;
                            return Err(e);
                        }
                    };
                    return Ok(Self {
                        handle,
                        jumps,
                        fs: SftpFs::new(sftp),
                    });
                }
                Ok(handle) => jumps.push((handle, hop.label.clone())),
                Err(e) => {
                    for (jump, _) in jumps.iter().rev() {
                        disconnect_quietly(jump).await;
                    }
                    return Err(if is_target {
                        e
                    } else {
                        jump_error(&hop.label, e)
                    });
                }
            }
        }
        unreachable!("the target hop always returns")
    }

    /// The SFTP filesystem of this session.
    pub fn fs(&self) -> &SftpFs {
        &self.fs
    }

    /// Open another SFTP channel on this connection. Transfers give each
    /// worker its own, so one copy never queues behind another's requests
    /// (or behind the panes' browsing on [`SshSession::fs`]).
    /// `NotConnected` once the connection is gone.
    pub async fn open_sftp_channel(&self) -> CoreResult<SftpFs> {
        if self.is_closed() {
            return Err(CoreError::NotConnected);
        }
        match open_sftp(&self.handle).await {
            Ok(sftp) => Ok(SftpFs::new(sftp)),
            Err(_) if self.is_closed() => Err(CoreError::NotConnected),
            Err(e) => Err(e),
        }
    }

    /// Whether the SSH connection has ended.
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// Ask the server for a sign of life: a keepalive ping that must be
    /// answered within [`PROBE_TIMEOUT`]. A connection that died without a
    /// FIN or RST reaching the reader (a dropped network, a sleeping NAT)
    /// is only noticed by a write or the keepalive timer, so an SFTP
    /// request on it times out first; this tells such a timeout apart from
    /// a server that is merely slow. `false` when the connection is gone or
    /// did not answer.
    pub async fn probe(&self) -> bool {
        if self.is_closed() {
            return false;
        }
        // `send_ping` also returns once the session ends (its reply channel
        // is dropped), so the connection is checked again afterwards.
        let answered = tokio::time::timeout(PROBE_TIMEOUT, self.handle.send_ping()).await;
        matches!(answered, Ok(Ok(()))) && !self.is_closed()
    }

    /// Close SFTP and the SSH connection, then its jump connections (best
    /// effort).
    pub async fn disconnect(&self) {
        self.fs.close().await;
        close_all(&self.handle, &self.jumps).await;
    }
}

async fn close_all(target: &Handle, jumps: &[Handle]) {
    disconnect_quietly(target).await;
    for jump in jumps.iter().rev() {
        disconnect_quietly(jump).await;
    }
}

async fn disconnect_quietly(handle: &Handle) {
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
}

/// A failure at a jump host, worded so the user knows which hop failed.
/// Host key verdicts keep their own kind (they name the host already).
fn jump_error(label: &str, err: CoreError) -> CoreError {
    match err {
        CoreError::HostKeyChanged { .. } | CoreError::HostKeyRejected | CoreError::JumpHost(_) => {
            err
        }
        CoreError::PasswordRequired => CoreError::JumpHost(format!(
            "{label} needs a password; connect to it once and choose to remember it"
        )),
        CoreError::PassphraseRequired => CoreError::JumpHost(format!(
            "{label} needs a key passphrase; connect to it once and choose to remember it"
        )),
        other => CoreError::JumpHost(format!("{label}: {other}")),
    }
}

async fn tcp_connect(hop: &Hop) -> CoreResult<tokio::net::TcpStream> {
    let connecting = tokio::net::TcpStream::connect((hop.host.as_str(), hop.port));
    let stream = match tokio::time::timeout(HANDSHAKE_TIMEOUT, connecting).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => return Err(map_connect_error(russh::Error::IO(e))),
        Err(_) => return Err(CoreError::ConnectFailed("timed out".into())),
    };
    if let Err(e) = stream.set_nodelay(true) {
        tracing::debug!("could not disable Nagle: {e}");
    }
    Ok(stream)
}

/// A `direct-tcpip` channel from the jump connection `via` to `hop`.
async fn open_tunnel(
    via: &Handle,
    via_label: &str,
    hop: &Hop,
) -> CoreResult<russh::ChannelStream<client::Msg>> {
    via.channel_open_direct_tcpip(hop.host.as_str(), u32::from(hop.port), "127.0.0.1", 0)
        .await
        .map(russh::Channel::into_stream)
        .map_err(|e| {
            tracing::debug!("direct-tcpip open failed: {e}");
            CoreError::JumpHost(format!(
                "{via_label} could not reach {}:{}",
                hop.host, hop.port
            ))
        })
}

/// The SSH handshake (including the host key check) over `stream`.
async fn handshake<S>(
    config: Arc<client::Config>,
    stream: S,
    handler: ClientHandler,
) -> CoreResult<Handle>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let connecting = client::connect_stream(config, stream, handler);
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, connecting).await {
        Ok(Ok(handle)) => Ok(handle),
        Ok(Err(HandlerError::HostKey(e))) => Err(e),
        Ok(Err(HandlerError::Ssh(e))) => Err(map_connect_error(e)),
        Err(_) => Err(CoreError::ConnectFailed("timed out".into())),
    }
}

async fn authenticate(
    handle: &mut Handle,
    hop: &Hop,
    password: Option<Secret>,
    passphrase: Option<Secret>,
    agent: Option<&AgentLocation>,
) -> CoreResult<()> {
    let user = hop.user.as_str();
    let accepted = match &hop.auth {
        HopAuth::Password => {
            let password = password.ok_or(CoreError::PasswordRequired)?;
            let result = handle
                .authenticate_password(user, password.expose())
                .await
                .map_err(map_connect_error)?;
            matches!(result, AuthResult::Success)
        }
        HopAuth::KeyFile { path } => {
            let key = load_key(path, passphrase.as_ref()).await?;
            try_key(handle, user, key).await?
        }
        HopAuth::Agent => {
            let location =
                agent.ok_or_else(|| CoreError::Agent("no SSH agent is running".into()))?;
            try_agent(handle, user, location).await?
        }
        HopAuth::Identities { files } => {
            try_identities(handle, user, files, passphrase.as_ref(), agent).await?
        }
    };
    if accepted {
        Ok(())
    } else {
        Err(CoreError::AuthFailed)
    }
}

/// `~/.ssh/config` style: each identity file in turn, then the agent.
///
/// A missing or unusable file is skipped, like OpenSSH does. When nothing
/// got in, a key that needed a passphrase (or got a wrong one) is reported
/// so the user can supply it; otherwise the login failed.
async fn try_identities(
    handle: &mut Handle,
    user: &str,
    files: &[String],
    passphrase: Option<&Secret>,
    agent: Option<&AgentLocation>,
) -> CoreResult<bool> {
    let mut needs_passphrase = false;
    let mut wrong_passphrase = false;
    for file in files {
        match load_key(file, passphrase).await {
            Ok(key) => {
                if try_key(handle, user, key).await? {
                    return Ok(true);
                }
            }
            Err(CoreError::PassphraseRequired) => needs_passphrase = true,
            Err(CoreError::KeyFile(reason)) if reason == WRONG_PASSPHRASE => {
                wrong_passphrase = true
            }
            Err(e) => tracing::debug!("skipping an identity file: {e}"),
        }
    }
    if let Some(location) = agent {
        match try_agent(handle, user, location).await {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            // No agent (or no keys in it) is not a failure on its own here.
            Err(e) => tracing::debug!("agent fallback unavailable: {e}"),
        }
    }
    if wrong_passphrase {
        Err(CoreError::KeyFile(WRONG_PASSPHRASE.into()))
    } else if needs_passphrase {
        Err(CoreError::PassphraseRequired)
    } else {
        Ok(false)
    }
}

/// The server's preferred RSA signature hash, asked only for RSA keys
/// (other key types ignore it).
async fn rsa_hash(handle: &Handle, key: &PublicKey) -> Option<HashAlg> {
    if !key.algorithm().is_rsa() {
        return None;
    }
    handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten()
}

async fn try_key(
    handle: &mut Handle,
    user: &str,
    key: russh::keys::PrivateKey,
) -> CoreResult<bool> {
    let hash = rsa_hash(handle, key.public_key()).await;
    let result = handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(map_connect_error)?;
    Ok(matches!(result, AuthResult::Success))
}

/// Offer each identity of the agent in turn; `true` once one is accepted.
async fn try_agent(handle: &mut Handle, user: &str, location: &AgentLocation) -> CoreResult<bool> {
    let mut agent = agent::connect(location).await?;
    let identities = agent.request_identities().await.map_err(|e| {
        tracing::debug!("could not list the agent's keys: {e}");
        CoreError::Agent("the SSH agent did not answer".into())
    })?;
    if identities.is_empty() {
        return Err(CoreError::Agent("the SSH agent has no keys".into()));
    }
    for identity in identities {
        let public = identity.public_key().into_owned();
        let hash = rsa_hash(handle, &public).await;
        let result = match identity {
            AgentIdentity::PublicKey { key, .. } => {
                handle
                    .authenticate_publickey_with(user, key, hash, &mut agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                handle
                    .authenticate_certificate_with(user, certificate, hash, &mut agent)
                    .await
            }
        };
        match result {
            Ok(AuthResult::Success) => return Ok(true),
            Ok(AuthResult::Failure { .. }) => {}
            Err(e) => {
                tracing::debug!("agent authentication failed: {e}");
                return Err(CoreError::Agent(
                    "the SSH agent could not sign the login".into(),
                ));
            }
        }
    }
    Ok(false)
}

const WRONG_PASSPHRASE: &str = "wrong passphrase";

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
                WRONG_PASSPHRASE.into()
            } else {
                "unsupported or damaged key file".into()
            }))
        }
    }
}

async fn open_sftp(handle: &Handle) -> CoreResult<SftpSession> {
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
        .map_err(|e| match e {
            // No VERSION reply: maybe a dead connection (see `probe`).
            russh_sftp::client::error::Error::Timeout => CoreError::NoAnswer,
            e => failed(&e),
        })
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
    prompts: Option<Arc<HostKeyPrompts>>,
    events: EventBus,
    /// A jump connection: its end takes the session down too.
    is_jump: bool,
    on_closed: SharedOnClosed,
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
            self.prompts.as_deref(),
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
        let (text, result) = match (reason, self.is_jump) {
            (DisconnectReason::ReceivedDisconnect(_), false) => {
                ("the server closed the connection", Ok(()))
            }
            (DisconnectReason::ReceivedDisconnect(_), true) => {
                ("the jump host closed the connection", Ok(()))
            }
            (DisconnectReason::Error(e), false) => ("the connection was lost", Err(e)),
            (DisconnectReason::Error(e), true) => {
                ("the connection to the jump host was lost", Err(e))
            }
        };
        let on_closed = self
            .on_closed
            .lock()
            .expect("on_closed lock poisoned")
            .take();
        if let Some(on_closed) = on_closed {
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
