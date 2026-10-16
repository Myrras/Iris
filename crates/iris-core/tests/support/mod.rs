//! A hermetic, in-process SSH + SFTP server (and ssh-agent) for the
//! integration tests.
//!
//! russh's server side plus a small russh-sftp handler serve a `tempfile`
//! folder (the virtual root `/`, also the login folder) on 127.0.0.1 with an
//! ephemeral port. It accepts one user with a password and, optionally, one
//! public key. The host key is generated per server, so two servers on the
//! same address present different keys (used for the "changed key" case).
//!
//! For jump host tests a server can be started *hidden* (no TCP listener at
//! all) and routed to from a jump server's `direct-tcpip` handler over an
//! in-memory pipe, so the only way to reach it is through the jump.
//!
//! Only the SFTP requests Iris uses are implemented: browsing, reading and
//! writing files, and the file operations (mkdir, rename, remove, rmdir,
//! setstat). For the transfer tests the server counts how many files are
//! open at once (across all channels and connections) and can slow every
//! read and write (and folder listing) down. For the reconnect tests it can
//! cut its TCP connections dead (no SSH goodbye, like a dropped link) and
//! refuse new ones. All data is fictitious.

#![allow(dead_code)] // Each test binary uses a different subset.

use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{Auth, Msg, Session};
use russh::{Channel, ChannelId, ChannelOpenFailure};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use tempfile::TempDir;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

pub const USER: &str = "demo";
pub const PASSWORD: &str = "correct-horse-battery";
pub const HOST: &str = "127.0.0.1";

/// How many names one READDIR reply carries (OpenSSH sends ~100 too).
const READDIR_BATCH: usize = 100;

/// The SSH side of one server: what every accepted connection shares.
struct Endpoint {
    config: Arc<russh::server::Config>,
    shared: Arc<Shared>,
    sessions: Arc<std::sync::Mutex<Vec<russh::server::Handle>>>,
    /// The byte pumps between each accepted TCP socket and its SSH session;
    /// aborting one drops the socket mid-stream.
    pumps: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Drop new TCP connections right after accepting them.
    refusing: AtomicBool,
}

impl Endpoint {
    /// Serve an accepted TCP socket through a pump that can be cut.
    fn serve_tcp(&self, socket: tokio::net::TcpStream) {
        if self.refusing.load(Ordering::SeqCst) {
            return;
        }
        let (near, far) = tokio::io::duplex(256 * 1024);
        self.serve(far);
        let latency = Duration::from_micros(self.shared.stats.latency_us.load(Ordering::SeqCst));
        let pump = tokio::spawn(async move {
            if latency.is_zero() {
                let mut socket = socket;
                let mut near = near;
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut near).await;
                return;
            }
            // Both directions in this one task, so aborting it cuts both.
            let (socket_rx, socket_tx) = socket.into_split();
            let (near_rx, near_tx) = tokio::io::split(near);
            tokio::join!(
                delayed_copy(socket_rx, near_tx, latency),
                delayed_copy(near_rx, socket_tx, latency),
            );
        });
        self.pumps.lock().unwrap().push(pump);
    }

    /// Run one SSH connection over `socket` in the background.
    fn serve<S>(&self, socket: S)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let handler = SshHandler {
            shared: Arc::clone(&self.shared),
            channels: Arc::new(Mutex::new(HashMap::new())),
        };
        let config = Arc::clone(&self.config);
        let accepted = Arc::clone(&self.sessions);
        tokio::spawn(async move {
            if let Ok(running) = russh::server::run_stream(config, socket, handler).await {
                accepted.lock().unwrap().push(running.handle());
                let _ = running.await;
            }
        });
    }
}

/// Copy `from` into `to`, each chunk arriving `latency` after it was read
/// (a one-way network delay that does not limit throughput: later chunks
/// are already on their way while one waits).
async fn delayed_copy<R, W>(mut from: R, mut to: W, latency: Duration)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(tokio::time::Instant, Vec<u8>)>();
    let read = async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match from.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let due = tokio::time::Instant::now() + latency;
                    if tx.send((due, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    };
    let write = async move {
        while let Some((due, data)) = rx.recv().await {
            tokio::time::sleep_until(due).await;
            if to.write_all(&data).await.is_err() {
                break;
            }
        }
        let _ = to.shutdown().await;
    };
    tokio::join!(read, write);
}

/// A running test server. Dropping it stops accepting connections.
pub struct TestServer {
    /// The TCP port; 0 for a hidden server.
    pub port: u16,
    root: TempDir,
    host_key: PrivateKey,
    task: Option<tokio::task::JoinHandle<()>>,
    endpoint: Arc<Endpoint>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

impl TestServer {
    /// Start a server that accepts [`USER`] with [`PASSWORD`] and, when
    /// given, `authorized_key`.
    pub async fn start(authorized_key: Option<PublicKey>) -> Self {
        Self::launch(authorized_key, true, Vec::new()).await
    }

    /// Like [`TestServer::start`], but without a TCP listener: reachable
    /// only through a jump server that routes to it.
    pub async fn start_hidden(authorized_key: Option<PublicKey>) -> Self {
        Self::launch(authorized_key, false, Vec::new()).await
    }

    /// A listening jump server whose `direct-tcpip` channels to
    /// `(host, port)` reach the given (hidden) server; anything else is
    /// refused.
    pub async fn start_jump(
        authorized_key: Option<PublicKey>,
        routes: &[(&str, u16, &TestServer)],
    ) -> Self {
        let routes = routes
            .iter()
            .map(|(host, port, server)| ((host.to_string(), *port), Arc::clone(&server.endpoint)))
            .collect();
        Self::launch(authorized_key, true, routes).await
    }

    async fn launch(
        authorized_key: Option<PublicKey>,
        listen: bool,
        routes: Vec<((String, u16), Arc<Endpoint>)>,
    ) -> Self {
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
        let shared = Arc::new(Shared {
            root: root.path().canonicalize().unwrap(),
            authorized_key,
            routes: routes.into_iter().collect(),
            stats: Arc::default(),
        });
        let endpoint = Arc::new(Endpoint {
            config,
            shared,
            sessions: Arc::new(std::sync::Mutex::new(Vec::new())),
            pumps: std::sync::Mutex::default(),
            refusing: AtomicBool::new(false),
        });

        let (port, task) = if listen {
            let listener = TcpListener::bind((HOST, 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let endpoint = Arc::clone(&endpoint);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        return;
                    };
                    endpoint.serve_tcp(socket);
                }
            });
            (port, Some(task))
        } else {
            (0, None)
        };

        Self {
            port,
            root,
            host_key,
            task,
            endpoint,
        }
    }

    /// Close every accepted connection from the server side, as a server
    /// restart or an idle timeout would.
    pub async fn disconnect_all(&self) {
        let handles: Vec<_> = self.endpoint.sessions.lock().unwrap().drain(..).collect();
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

    /// Cut every accepted TCP connection dead: the sockets close with no
    /// SSH disconnect message, as when the network drops.
    pub fn kill_all(&self) {
        for pump in self.endpoint.pumps.lock().unwrap().drain(..) {
            pump.abort();
        }
        self.endpoint.sessions.lock().unwrap().clear();
    }

    /// While set, new connections are dropped as soon as they arrive (the
    /// server is "gone"); existing ones are not touched.
    pub fn set_refusing(&self, refusing: bool) {
        self.endpoint.refusing.store(refusing, Ordering::SeqCst);
    }

    /// Delay every folder listing (OPENDIR) by `delay`, so a folder walk
    /// takes long enough to cut off.
    pub fn set_list_delay(&self, delay: Duration) {
        self.endpoint
            .shared
            .stats
            .list_delay_us
            .store(delay.as_micros() as u64, Ordering::SeqCst);
    }

    /// Delay every CLOSE of a file by `delay`: the data is on disk, but the
    /// server takes its time to confirm the end of the file (as one that
    /// flushes to network storage or scans the file on close does).
    pub fn set_close_delay(&self, delay: Duration) {
        self.endpoint
            .shared
            .stats
            .close_delay_us
            .store(delay.as_micros() as u64, Ordering::SeqCst);
    }

    /// Give connections accepted from now on a one-way delay of `latency`
    /// each way (a round trip of twice that), like a distant server.
    pub fn set_latency(&self, latency: Duration) {
        self.endpoint
            .shared
            .stats
            .latency_us
            .store(latency.as_micros() as u64, Ordering::SeqCst);
    }

    /// The most folders that were being listed at the same time (OPENDIR
    /// to CLOSE, over every channel) since the last
    /// [`TestServer::reset_listing_stats`].
    pub fn max_open_dirs(&self) -> usize {
        self.endpoint
            .shared
            .stats
            .max_open_dirs
            .load(Ordering::SeqCst)
    }

    /// Folder listings (OPENDIRs) served since the last reset.
    pub fn listings(&self) -> usize {
        self.endpoint.shared.stats.listings.load(Ordering::SeqCst)
    }

    pub fn reset_listing_stats(&self) {
        let stats = &self.endpoint.shared.stats;
        stats
            .max_open_dirs
            .store(stats.open_dirs.load(Ordering::SeqCst), Ordering::SeqCst);
        stats.listings.store(0, Ordering::SeqCst);
    }

    /// The most files that were open at the same time since the last
    /// [`TestServer::reset_max_open_files`].
    pub fn max_open_files(&self) -> usize {
        self.endpoint.shared.stats.max_open.load(Ordering::SeqCst)
    }

    pub fn reset_max_open_files(&self) {
        let stats = &self.endpoint.shared.stats;
        stats
            .max_open
            .store(stats.open.load(Ordering::SeqCst), Ordering::SeqCst);
    }

    /// Delay every READ and WRITE by `delay` (zero turns it off), so a
    /// transfer takes long enough to watch, cancel or cut off.
    pub fn set_io_delay(&self, delay: Duration) {
        self.endpoint
            .shared
            .stats
            .delay_us
            .store(delay.as_micros() as u64, Ordering::SeqCst);
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
        self.known_hosts_line_as(HOST, self.port)
    }

    /// A `known_hosts` line that trusts this server under another name
    /// (how a hidden server is known behind its jump host).
    pub fn known_hosts_line_as(&self, host: &str, port: u16) -> String {
        let name = if port == 22 {
            host.to_string()
        } else {
            format!("[{host}]:{port}")
        };
        format!("{name} {}\n", self.host_public_key().to_openssh().unwrap())
    }
}

/// An in-process ssh-agent on a temp Unix socket holding `keys`.
pub struct TestAgent {
    pub socket: PathBuf,
    _dir: TempDir,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestAgent {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(unix)]
pub async fn start_agent(keys: &[PrivateKey]) -> TestAgent {
    use russh::keys::agent::client::AgentClient;

    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("agent.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let task = tokio::spawn(async move {
        let incoming = tokio_stream::wrappers::UnixListenerStream::new(listener);
        let _ = russh::keys::agent::server::serve(incoming, ()).await;
    });
    let mut client = AgentClient::connect_uds(&socket).await.unwrap();
    for key in keys {
        client.add_identity(key, &[]).await.unwrap();
    }
    TestAgent {
        socket,
        _dir: dir,
        task,
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
    /// `direct-tcpip` destinations this server can reach.
    routes: HashMap<(String, u16), Arc<Endpoint>>,
    stats: Arc<Stats>,
}

/// Instrumentation shared by every SFTP channel of a server.
#[derive(Default)]
struct Stats {
    /// Files open right now.
    open: AtomicUsize,
    max_open: AtomicUsize,
    /// Delay per READ / WRITE, in microseconds.
    delay_us: AtomicU64,
    /// Delay per OPENDIR, in microseconds.
    list_delay_us: AtomicU64,
    /// Delay per CLOSE of a file, in microseconds.
    close_delay_us: AtomicU64,
    /// One-way network delay of connections accepted from now on, in
    /// microseconds.
    latency_us: AtomicU64,
    /// Folders open (OPENDIR to CLOSE) right now, and the most at once.
    open_dirs: AtomicUsize,
    max_open_dirs: AtomicUsize,
    /// OPENDIRs served.
    listings: AtomicUsize,
}

impl Stats {
    fn opened(&self) {
        let now = self.open.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_open.fetch_max(now, Ordering::SeqCst);
    }

    fn closed(&self) {
        self.open.fetch_sub(1, Ordering::SeqCst);
    }

    async fn delay(&self) {
        let us = self.delay_us.load(Ordering::SeqCst);
        if us > 0 {
            tokio::time::sleep(Duration::from_micros(us)).await;
        }
    }

    async fn list_delay(&self) {
        let us = self.list_delay_us.load(Ordering::SeqCst);
        if us > 0 {
            tokio::time::sleep(Duration::from_micros(us)).await;
        }
    }

    async fn close_delay(&self) {
        let us = self.close_delay_us.load(Ordering::SeqCst);
        if us > 0 {
            tokio::time::sleep(Duration::from_micros(us)).await;
        }
    }
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

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let route = u16::try_from(port_to_connect)
            .ok()
            .and_then(|port| self.shared.routes.get(&(host_to_connect.to_string(), port)));
        let Some(target) = route else {
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        reply.accept().await;
        // The target's SSH runs on one end of an in-memory pipe; the
        // channel is spliced onto the other.
        let (near, far) = tokio::io::duplex(64 * 1024);
        target.serve(far);
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let mut near = near;
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut near).await;
        });
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
                    files: HashMap::new(),
                    next_handle: 0,
                    stats: Arc::clone(&self.shared.stats),
                };
                russh_sftp::server::run(channel.into_stream(), sftp).await;
            }
            _ => session.channel_failure(channel_id)?,
        }
        Ok(())
    }
}

/// Serves the folder under `root`. Virtual paths are POSIX paths rooted at
/// `/`; `..` is refused so nothing outside `root` is reachable.
struct SftpHandler {
    root: PathBuf,
    dirs: HashMap<String, VecDeque<File>>,
    files: HashMap<String, std::fs::File>,
    next_handle: u64,
    stats: Arc<Stats>,
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".into(),
        language_tag: "en-US".into(),
    }
}

impl SftpHandler {
    fn next_handle(&mut self) -> String {
        self.next_handle += 1;
        self.next_handle.to_string()
    }

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
        self.stats.list_delay().await;
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
        let handle = self.next_handle();
        self.dirs.insert(handle.clone(), files);
        self.stats.listings.fetch_add(1, Ordering::SeqCst);
        let now = self.stats.open_dirs.fetch_add(1, Ordering::SeqCst) + 1;
        self.stats.max_open_dirs.fetch_max(now, Ordering::SeqCst);
        Ok(Handle { id, handle })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        if pflags.contains(OpenFlags::APPEND) || pflags.contains(OpenFlags::EXCLUDE) {
            return Err(StatusCode::OpUnsupported);
        }
        let file = std::fs::OpenOptions::new()
            .read(pflags.contains(OpenFlags::READ))
            .write(pflags.contains(OpenFlags::WRITE))
            .create(pflags.contains(OpenFlags::CREATE))
            .truncate(pflags.contains(OpenFlags::TRUNCATE))
            .open(self.real(&filename)?)
            .map_err(status_of)?;
        let handle = self.next_handle();
        self.files.insert(handle.clone(), file);
        self.stats.opened();
        Ok(Handle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        use std::io::{Read, Seek, SeekFrom};
        self.stats.delay().await;
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(status_of)?;
        let mut data = Vec::new();
        file.take(u64::from(len))
            .read_to_end(&mut data)
            .map_err(status_of)?;
        if data.is_empty() {
            return Err(StatusCode::Eof);
        }
        Ok(Data { id, data })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        use std::io::{Seek, SeekFrom, Write};
        self.stats.delay().await;
        let file = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(status_of)?;
        file.write_all(&data).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let file = self.files.get(&handle).ok_or(StatusCode::Failure)?;
        let meta = file.metadata().map_err(status_of)?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&meta),
        })
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        std::fs::create_dir(self.real(&path)?).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        std::fs::remove_dir(self.real(&path)?).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.real(&filename)?).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let (from, to) = (self.real(&oldpath)?, self.real(&newpath)?);
        // Like OpenSSH: an existing target is a failure, never replaced.
        if std::fs::symlink_metadata(&to).is_ok() {
            return Err(StatusCode::Failure);
        }
        std::fs::rename(from, to).map_err(status_of)?;
        Ok(ok(id))
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        use std::os::unix::fs::PermissionsExt;
        let real = self.real(&path)?;
        if let Some(mtime) = attrs.mtime {
            let time = std::time::UNIX_EPOCH + Duration::from_secs(u64::from(mtime));
            std::fs::File::open(&real)
                .and_then(|f| f.set_modified(time))
                .map_err(status_of)?;
        }
        if let Some(mode) = attrs.permissions {
            // chmod(2) follows links, as OpenSSH's SETSTAT does.
            std::fs::set_permissions(&real, std::fs::Permissions::from_mode(mode & 0o7777))
                .map_err(status_of)?;
        }
        Ok(ok(id))
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
        if self.dirs.remove(&handle).is_some() {
            self.stats.open_dirs.fetch_sub(1, Ordering::SeqCst);
        }
        if self.files.remove(&handle).is_some() {
            self.stats.closed();
            self.stats.close_delay().await;
        }
        Ok(ok(id))
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
