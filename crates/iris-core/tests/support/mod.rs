//! A hermetic, in-process SSH + SFTP server for the integration tests.
//!
//! russh's server side plus a small russh-sftp handler serve a `tempfile`
//! folder (the virtual root `/`, also the login folder) on 127.0.0.1 with an
//! ephemeral port. It accepts one user with a password and, optionally, one
//! public key. The host key is generated per server, so two servers on the
//! same address present different keys (used for the "changed key" case).
//!
//! Only the SFTP requests the browsing code needs are implemented. All data
//! is fictitious.

#![allow(dead_code)] // Each test binary uses a different subset.

use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, File, FileAttributes, Handle, Name, Status, StatusCode, Version,
};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

pub const USER: &str = "demo";
pub const PASSWORD: &str = "correct-horse-battery";
pub const HOST: &str = "127.0.0.1";

/// How many names one READDIR reply carries (OpenSSH sends ~100 too).
const READDIR_BATCH: usize = 100;

/// A running test server. Dropping it stops accepting connections.
pub struct TestServer {
    pub port: u16,
    root: TempDir,
    host_key: PrivateKey,
    task: tokio::task::JoinHandle<()>,
    sessions: Arc<std::sync::Mutex<Vec<russh::server::Handle>>>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestServer {
    /// Start a server that accepts [`USER`] with [`PASSWORD`] and, when
    /// given, `authorized_key`.
    pub async fn start(authorized_key: Option<PublicKey>) -> Self {
        let host_key = random_key();
        let config = Arc::new(russh::server::Config {
            keys: vec![host_key.clone()],
            // Fail wrong-password attempts immediately instead of after the
            // default anti-bruteforce delay.
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind((HOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared = Arc::new(Shared {
            root: root.path().canonicalize().unwrap(),
            authorized_key,
        });

        let sessions = Arc::new(std::sync::Mutex::new(Vec::new()));
        let accepted = Arc::clone(&sessions);
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let handler = SshHandler {
                    shared: Arc::clone(&shared),
                    channels: Arc::new(Mutex::new(HashMap::new())),
                };
                let config = Arc::clone(&config);
                let accepted = Arc::clone(&accepted);
                tokio::spawn(async move {
                    if let Ok(running) = russh::server::run_stream(config, socket, handler).await {
                        accepted.lock().unwrap().push(running.handle());
                        let _ = running.await;
                    }
                });
            }
        });

        Self {
            port,
            root,
            host_key,
            task,
            sessions,
        }
    }

    /// Close every accepted connection from the server side, as a server
    /// restart or an idle timeout would.
    pub async fn disconnect_all(&self) {
        let handles: Vec<_> = self.sessions.lock().unwrap().drain(..).collect();
        for handle in handles {
            let _ = handle
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "shutting down".into(),
                    "en".into(),
                )
                .await;
        }
    }

    /// The real folder behind the virtual `/`.
    pub fn root(&self) -> &Path {
        self.root.path()
    }

    pub fn host_public_key(&self) -> PublicKey {
        self.host_key.public_key().clone()
    }

    /// A `known_hosts` line that trusts this server.
    pub fn known_hosts_line(&self) -> String {
        format!(
            "[{HOST}]:{} {}\n",
            self.port,
            self.host_public_key().to_openssh().unwrap()
        )
    }
}

/// A fresh Ed25519 key.
pub fn random_key() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}

/// Write `key` as an OpenSSH private key file, encrypted when a
/// `passphrase` is given.
pub fn write_key_file(path: &Path, key: &PrivateKey, passphrase: Option<&str>) {
    let key = match passphrase {
        Some(p) => key.encrypt(&mut rand::rng(), p).unwrap(),
        None => key.clone(),
    };
    std::fs::write(path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
}

struct Shared {
    root: PathBuf,
    authorized_key: Option<PublicKey>,
}

struct SshHandler {
    shared: Arc<Shared>,
    channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl russh::server::Handler for SshHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == USER && password == PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        let allowed = self
            .shared
            .authorized_key
            .as_ref()
            .is_some_and(|k| k.key_data() == public_key.key_data());
        Ok(if user == USER && allowed {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.close(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let channel = self.channels.lock().await.remove(&channel_id);
        match (name, channel) {
            ("sftp", Some(channel)) => {
                session.channel_success(channel_id)?;
                let sftp = SftpHandler {
                    root: self.shared.root.clone(),
                    dirs: HashMap::new(),
                    next_handle: 0,
                };
                russh_sftp::server::run(channel.into_stream(), sftp).await;
            }
            _ => session.channel_failure(channel_id)?,
        }
        Ok(())
    }
}

/// Serves the folder under `root` read-only. Virtual paths are POSIX paths
/// rooted at `/`; `..` is refused so nothing outside `root` is reachable.
struct SftpHandler {
    root: PathBuf,
    dirs: HashMap<String, VecDeque<File>>,
    next_handle: u64,
}

impl SftpHandler {
    fn real(&self, path: &str) -> Result<PathBuf, StatusCode> {
        let mut real = self.root.clone();
        for part in Path::new(path).components() {
            match part {
                Component::Normal(p) => real.push(p),
                Component::RootDir | Component::CurDir => {}
                _ => return Err(StatusCode::PermissionDenied),
            }
        }
        Ok(real)
    }
}

/// Normalize a virtual path to absolute form (`.` and `` are the root).
fn virtual_abs(path: &str) -> String {
    let parts: Vec<&str> = path
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    format!("/{}", parts.join("/"))
}

fn status_of(err: std::io::Error) -> StatusCode {
    match err.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

/// Attributes from (l)stat metadata, keeping the full unix mode (type bits
/// included, so symlinks stay symlinks).
fn attrs_of(meta: &std::fs::Metadata) -> FileAttributes {
    use std::os::unix::fs::MetadataExt;
    FileAttributes {
        size: Some(meta.len()),
        uid: Some(meta.uid()),
        gid: Some(meta.gid()),
        permissions: Some(meta.mode()),
        atime: Some(meta.atime() as u32),
        mtime: Some(meta.mtime() as u32),
        ..FileAttributes::default()
    }
}

impl russh_sftp::server::Handler for SftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(virtual_abs(&path))],
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let real = self.real(&path)?;
        let mut files = VecDeque::new();
        for item in std::fs::read_dir(&real).map_err(status_of)? {
            let item = item.map_err(status_of)?;
            let meta = std::fs::symlink_metadata(item.path()).map_err(status_of)?;
            files.push_back(File::new(
                item.file_name().to_string_lossy().into_owned(),
                attrs_of(&meta),
            ));
        }
        self.next_handle += 1;
        let handle = self.next_handle.to_string();
        self.dirs.insert(handle.clone(), files);
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let files = self.dirs.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if files.is_empty() {
            return Err(StatusCode::Eof);
        }
        let take = files.len().min(READDIR_BATCH);
        Ok(Name {
            id,
            files: files.drain(..take).collect(),
        })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.dirs.remove(&handle);
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en-US".into(),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta = std::fs::metadata(self.real(&path)?).map_err(status_of)?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&meta),
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta = std::fs::symlink_metadata(self.real(&path)?).map_err(status_of)?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&meta),
        })
    }

    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let target = std::fs::read_link(self.real(&path)?).map_err(status_of)?;
        Ok(Name {
            id,
            files: vec![File::dummy(target.to_string_lossy().into_owned())],
        })
    }
}
