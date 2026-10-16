//! iris-core — the UI-agnostic heart of the application.
//!
//! Owns all domain logic and state behind a single entry point, [`Core`], and
//! has **zero** dependency on Tauri (or any UI). The Tauri shell (`src-tauri`)
//! is a thin adapter over [`Core`]'s public API, which means the whole domain is
//! testable on plain `cargo test` without spinning up a window.
//!
//! ## The core contract
//! All mutation flows through [`Core`]. Keep orchestration/domain logic here;
//! the shell should only (de)serialize arguments and forward calls. Changes the
//! UI must hear about are published as [`CoreEvent`]s on the core's event bus
//! ([`Core::subscribe_events`]).
//!
//! Besides the app plumbing (persisted [`IrisSettings`], the event bus, the
//! close guard's [`Core::has_active_work`]) the core holds the saved
//! [`ConnectionProfile`]s, their remembered secrets ([`secrets`]), the live
//! SSH/SFTP sessions and the [`FileSystem`] calls the browsing panes make
//! against either side ([`FsTarget`]): browsing, the file operations (new
//! folder, rename, delete — to the Trash locally, permanently remotely —
//! and chmod) and [`Preview`]s. Connecting understands password, key file,
//! ssh-agent and `~/.ssh/config` logins and jump hosts. Uploads and
//! downloads run through the [`transfer`] engine (a queue of per-file jobs
//! with conflict handling and resume).
//!
//! ## Sessions outlive their connections
//! A connection that drops unexpectedly (keepalives notice a dead link) is
//! re-established in the background with backoff — 1, 2, 4, 8, 16 s, up to
//! the `reconnectAttempts` setting — under the **same [`SessionId`]**, so
//! the UI and the transfer jobs never remap anything; paused transfers
//! continue once it is back. Reconnecting never prompts: a login that would
//! need a secret or a host key decision, or one the server refuses, stops it
//! and the session shows `disconnected` with the reason until the user
//! retries ([`Core::reconnect`]) or closes it ([`Core::disconnect`]).

#![forbid(unsafe_code)]

pub mod connection;
pub mod error;
pub mod events;
pub mod fs;
pub mod ids;
mod persist;
pub mod preview;
pub mod secret;
pub mod secrets;
pub mod session_manager;
pub mod settings;
pub mod ssh;
pub mod ssh_config;
pub mod transfer;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::broadcast;

pub use connection::{AuthMethod, ConnectionProfile, JumpHost, ProfileStore};
pub use error::{CoreError, CoreResult};
pub use events::{CoreEvent, EventBus, SessionState};
pub use fs::{
    BatchFailure, BatchReport, Entry, EntryKind, FileSystem, FsTarget, LinkTargetKind, LocalFs,
    SystemTrash, Trash,
};
pub use ids::{BatchId, HostKeyRequestId, ProfileId, SessionId, TransferId};
pub use preview::Preview;
pub use secret::Secret;
pub use secrets::{KeychainStore, MemorySecretStore, SecretKind, SecretStore};
pub use settings::{IrisSettings, IrisSettingsStore};
pub use ssh::AgentLocation;
pub use ssh_config::SshConfigHost;
pub use transfer::{
    ConflictResolution, ConflictSide, TransferDirection, TransferError, TransferItem, TransferJob,
    TransferList, TransferManager, TransferRequest, TransferState, TransferSummary,
};

use connection::route::{HopAuth, Resolver};
use session_manager::{LiveSession, ReconnectRun, Removed, SessionManager};
use ssh::hostkey::HostKeyPrompts;
use ssh::session::OnClosed;
use ssh::{ConnectRequest, HopRequest, SshSession};
use ssh_config::SshConfigFile;

/// What a connect may use besides the profile itself.
///
/// A secret left `None` is read from the [`SecretStore`] when the login
/// needs it. With `remember`, the secrets given here are stored there once
/// the login succeeded.
#[derive(Debug, Default)]
pub struct Credentials {
    pub password: Option<Secret>,
    pub passphrase: Option<Secret>,
    pub remember: bool,
}

/// The application's single entry point.
///
/// Cheap to share: a `Core` is a handle (clone it into any detached task;
/// the shell keeps one behind an `Arc`). Interior mutability keeps the
/// public API `&self`, so callers never need a mutable borrow. The core's
/// own background work (reconnecting a dropped session) holds a clone too.
#[derive(Clone)]
pub struct Core {
    inner: Arc<CoreInner>,
}

struct CoreInner {
    events: EventBus,
    settings: IrisSettingsStore,
    profiles: ProfileStore,
    sessions: SessionManager,
    host_key_prompts: Arc<HostKeyPrompts>,
    /// Where host keys are checked and learned. Unset until the shell calls
    /// [`Core::set_known_hosts_path`]; connecting fails until then, so no
    /// code path (tests included) can touch the real `~/.ssh/known_hosts`
    /// by accident.
    known_hosts: Mutex<Option<PathBuf>>,
    /// The OpenSSH client config. Unset (until the shell calls
    /// [`Core::set_ssh_config_path`]) reads as an empty config.
    ssh_config: Mutex<Option<PathBuf>>,
    /// Where the SSH agent is. Unset means no agent, so tests never reach
    /// the developer's real agent.
    agent: Mutex<Option<AgentLocation>>,
    /// Remembered passwords / passphrases. In memory until the shell
    /// installs the OS keychain ([`Core::set_secret_store`]).
    secrets: Mutex<Arc<dyn SecretStore>>,
    /// The local disk; its [`Trash`] is swappable ([`Core::set_trash`]).
    local: Mutex<LocalFs>,
    transfers: TransferManager,
    /// One step of the reconnect backoff ([`reconnect_delay_secs`] of them
    /// before each attempt); a second, shortened by tests.
    reconnect_unit: Mutex<Duration>,
}

impl Default for Core {
    fn default() -> Self {
        let events = EventBus::default();
        let settings = IrisSettingsStore::default();
        let sessions = SessionManager::default();
        let transfers = TransferManager::new(
            events.clone(),
            sessions.clone(),
            parallelism(&settings.get()),
        );
        Self {
            inner: Arc::new(CoreInner {
                events,
                settings,
                profiles: ProfileStore::default(),
                sessions,
                transfers,
                host_key_prompts: Arc::default(),
                known_hosts: Mutex::default(),
                ssh_config: Mutex::default(),
                agent: Mutex::default(),
                secrets: Mutex::new(Arc::new(MemorySecretStore::new())),
                local: Mutex::new(LocalFs::new()),
                reconnect_unit: Mutex::new(Duration::from_secs(1)),
            }),
        }
    }
}

const CONFIG_LOCK: &str = "core config lock poisoned";

/// Run `$call` against the filesystem `$target` addresses, bound to `$fs`
/// (a `&LocalFs` or `&SftpFs`). A remote call that finds the connection
/// gone drops the session ([`Core::forget_if_lost`]).
macro_rules! on_fs {
    ($core:ident, $target:expr, |$fs:ident| $call:expr) => {
        match $target {
            FsTarget::Local => {
                let local = $core.local();
                let $fs = &local;
                $call.await
            }
            FsTarget::Remote { session_id } => {
                let live = $core.inner.sessions.get(session_id)?;
                let $fs = live.ssh.fs();
                let result = $call.await;
                $core.forget_if_lost(session_id, live.generation, result)
            }
        }
    };
}

impl Core {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe to the core's lifecycle events. Each receiver sees every
    /// event published after it subscribed.
    pub fn subscribe_events(&self) -> broadcast::Receiver<CoreEvent> {
        self.inner.events.subscribe()
    }

    /// Back the settings with `path` (normally `{app_data_dir}/settings.json`)
    /// and load it. Until this is called the settings are in-memory only.
    pub fn set_settings_path(&self, path: PathBuf) {
        self.inner.settings.set_path(path);
        self.inner
            .transfers
            .set_parallelism(parallelism(&self.inner.settings.get()));
    }

    /// The current settings.
    pub fn settings(&self) -> IrisSettings {
        self.inner.settings.get()
    }

    /// Validate and persist `settings`, then announce
    /// [`CoreEvent::SettingsChanged`]. Returns what was stored (normalized).
    pub fn save_settings(&self, settings: IrisSettings) -> CoreResult<IrisSettings> {
        let saved = self.inner.settings.save(settings)?;
        self.inner.transfers.set_parallelism(parallelism(&saved));
        self.inner.events.publish(CoreEvent::SettingsChanged);
        Ok(saved)
    }

    // -- Connection profiles ------------------------------------------------

    /// Back the saved connections with `path` (normally
    /// `{app_data_dir}/profiles.json`) and load it. Until this is called the
    /// profiles are in-memory only.
    pub fn set_profiles_path(&self, path: PathBuf) {
        self.inner.profiles.set_path(path);
    }

    /// All saved connections, in the order they were created.
    pub fn list_profiles(&self) -> Vec<ConnectionProfile> {
        self.inner.profiles.list()
    }

    /// Validate and store (insert or replace by id) a connection, then
    /// announce [`CoreEvent::ProfilesChanged`]. Returns what was stored.
    pub fn save_profile(&self, profile: ConnectionProfile) -> CoreResult<ConnectionProfile> {
        let saved = self.inner.profiles.save(profile)?;
        self.inner.events.publish(CoreEvent::ProfilesChanged);
        Ok(saved)
    }

    /// Delete a saved connection (`NotFound` if unknown) and its remembered
    /// secrets, then announce [`CoreEvent::ProfilesChanged`]. Open sessions
    /// from it stay open; a connection that used it as its jump host reports
    /// that on its next connect.
    pub fn delete_profile(&self, id: ProfileId) -> CoreResult<()> {
        self.inner.profiles.delete(id)?;
        let store = self.secret_store();
        for kind in SecretKind::ALL {
            // The profile is gone either way; a keychain that refuses now
            // only leaves an orphaned entry behind.
            if let Err(e) = store.delete(id, kind) {
                tracing::warn!(kind = e.kind(), "could not delete a saved secret");
            }
        }
        self.inner.events.publish(CoreEvent::ProfilesChanged);
        Ok(())
    }

    // -- Secrets ----------------------------------------------------------------

    /// Keep remembered secrets in `store` (the shell installs
    /// [`KeychainStore`]; the default is in memory).
    pub fn set_secret_store(&self, store: Arc<dyn SecretStore>) {
        *self.inner.secrets.lock().expect(CONFIG_LOCK) = store;
    }

    fn secret_store(&self) -> Arc<dyn SecretStore> {
        Arc::clone(&self.inner.secrets.lock().expect(CONFIG_LOCK))
    }

    /// Remember `value` as the `kind` secret of a saved connection
    /// (`NotFound` if the profile is unknown).
    pub fn set_secret(
        &self,
        profile_id: ProfileId,
        kind: SecretKind,
        value: Secret,
    ) -> CoreResult<()> {
        self.inner.profiles.get(profile_id)?;
        if value.is_empty() {
            return Err(CoreError::InvalidInput(
                "the secret must not be empty".into(),
            ));
        }
        self.secret_store().set(profile_id, kind, &value)
    }

    /// Forget a remembered secret. Idempotent: nothing stored is fine.
    pub fn clear_secret(&self, profile_id: ProfileId, kind: SecretKind) -> CoreResult<()> {
        self.secret_store().delete(profile_id, kind)
    }

    /// A remembered secret, or `None` (also when the store cannot be read:
    /// the login then simply asks for it).
    fn stored_secret(&self, profile_id: ProfileId, kind: SecretKind) -> Option<Secret> {
        match self.secret_store().get(profile_id, kind) {
            Ok(secret) => secret,
            Err(e) => {
                tracing::warn!(kind = e.kind(), "could not read a saved secret");
                None
            }
        }
    }

    // -- SSH config and agent -------------------------------------------------

    /// The OpenSSH client config to read (`~/.ssh/config` in the shell,
    /// [`ssh_config::default_ssh_config_path`]; tests use temp files).
    pub fn set_ssh_config_path(&self, path: PathBuf) {
        *self.inner.ssh_config.lock().expect(CONFIG_LOCK) = Some(path);
    }

    fn load_ssh_config(&self) -> CoreResult<SshConfigFile> {
        let path = self.inner.ssh_config.lock().expect(CONFIG_LOCK).clone();
        match path {
            Some(path) => SshConfigFile::load(&path),
            None => Ok(SshConfigFile::default()),
        }
    }

    /// The concrete `Host` aliases of the SSH config, resolved, in file
    /// order (re-read on every call, so edits show up).
    pub fn list_ssh_config_hosts(&self) -> CoreResult<Vec<SshConfigHost>> {
        Ok(self.load_ssh_config()?.hosts())
    }

    /// Where agent logins find the SSH agent (the shell sets
    /// [`AgentLocation::System`]).
    pub fn set_agent(&self, location: AgentLocation) {
        *self.inner.agent.lock().expect(CONFIG_LOCK) = Some(location);
    }

    // -- Sessions -------------------------------------------------------------

    /// The `known_hosts` file host keys are verified against and learned
    /// into. The shell sets `~/.ssh/known_hosts`
    /// ([`ssh::hostkey::default_known_hosts_path`]); tests set a temp file.
    pub fn set_known_hosts_path(&self, path: PathBuf) {
        *self
            .inner
            .known_hosts
            .lock()
            .expect("known_hosts lock poisoned") = Some(path);
    }

    fn known_hosts_path(&self) -> CoreResult<PathBuf> {
        self.inner
            .known_hosts
            .lock()
            .expect("known_hosts lock poisoned")
            .clone()
            .ok_or_else(|| CoreError::Config("the known_hosts location is not configured".into()))
    }

    /// Open a session for a saved connection with secrets given per
    /// connect; see [`Core::connect_with`].
    pub async fn connect(
        &self,
        profile_id: ProfileId,
        password: Option<Secret>,
        passphrase: Option<Secret>,
    ) -> CoreResult<SessionId> {
        self.connect_with(
            profile_id,
            Credentials {
                password,
                passphrase,
                remember: false,
            },
        )
        .await
    }

    /// Open a session for a saved connection: reach it (through its jump
    /// hosts, each with its own host key check and login), verify the host
    /// key (an unknown key raises [`CoreEvent::HostKeyPrompt`] and waits for
    /// [`Core::answer_host_key`]), authenticate, open SFTP.
    ///
    /// The target uses `credentials` and falls back to its remembered
    /// secrets; jump hosts that are saved connections use their remembered
    /// secrets. A password profile with neither is `PasswordRequired`, an
    /// encrypted key `PassphraseRequired`; a wrong remembered secret fails
    /// like a typed one (`AuthFailed` / `KeyFile`), so the UI can ask again.
    /// With `credentials.remember` the given secrets are stored after a
    /// successful login. Nothing else keeps them.
    ///
    /// Every call opens a new session, also for a profile that already has
    /// one. Announces [`SessionState::Connecting`] first, then `Connected`
    /// or a `Disconnected` carrying the error text. Once connected, a
    /// connection that drops is re-established on its own (see
    /// [`Core::reconnect`]).
    pub async fn connect_with(
        &self,
        profile_id: ProfileId,
        credentials: Credentials,
    ) -> CoreResult<SessionId> {
        let session_id = SessionId::new();
        let pending = self.prepare(session_id, profile_id, credentials, true)?;
        self.publish_state(session_id, profile_id, SessionState::Connecting);
        match self.establish(pending).await {
            Ok(live) => {
                let generation = live.generation;
                let closed = live.ssh.is_closed();
                self.inner.sessions.insert(session_id, live);
                self.publish_state(session_id, profile_id, SessionState::Connected);
                if closed {
                    self.connection_lost(session_id, generation, LOST.into());
                }
                Ok(session_id)
            }
            Err(e) => {
                tracing::info!(kind = e.kind(), "connect failed");
                self.publish_state(
                    session_id,
                    profile_id,
                    SessionState::Disconnected {
                        reason: Some(e.to_string()),
                    },
                );
                Err(e)
            }
        }
    }

    /// Re-establish a session whose connection is gone, keeping its id: the
    /// "Retry" after Iris gave up reconnecting, or "Retry now" while it
    /// waits for the next attempt (which it then stops waiting for).
    ///
    /// Logs in like [`Core::connect_with`], so it may prompt for an unknown
    /// host key and take `credentials` for a login that needs them. Paused
    /// transfers of the session continue once it is back. Announces
    /// `Connecting`, then `Connected`, or on failure: a "Retry now" that
    /// interrupted the automatic reconnect goes back to it with the attempts
    /// that were left (the manual try counts as the one it was waiting for)
    /// unless the failure is one no retry can fix; otherwise the session is
    /// `Disconnected` with the reason. The error is returned either way. A
    /// session that is connected is left alone; one that is unknown or was
    /// disconnected by the user is `NotConnected`.
    pub async fn reconnect(
        &self,
        session_id: SessionId,
        credentials: Credentials,
    ) -> CoreResult<()> {
        let Some(run) = self.inner.sessions.begin_reconnect(session_id) else {
            return self.inner.sessions.get(session_id).map(|_| ());
        };
        let profile_id = run.profile_id;
        self.publish_state(session_id, profile_id, SessionState::Connecting);
        let attempt = async {
            let pending = self.prepare(session_id, profile_id, credentials, true)?;
            self.establish(pending).await
        };
        match attempt.await {
            Ok(live) => {
                self.install(session_id, run.run, live).await;
                Ok(())
            }
            Err(e) => {
                tracing::info!(kind = e.kind(), "reconnect failed");
                match run.interrupted {
                    Some((attempt, max)) if unrecoverable(&e).is_none() => {
                        // Back to the backoff loop, on this run (its cancel
                        // token is the one the session now holds).
                        tokio::spawn(self.clone().auto_reconnect(
                            session_id,
                            run,
                            attempt + 1..=max,
                            e.to_string(),
                        ));
                    }
                    _ => self.give_up(session_id, profile_id, run.run, e.to_string()),
                }
                Err(e)
            }
        }
    }

    /// Set one step of the reconnect backoff (default one second; attempt
    /// *n* waits [`reconnect_delay_secs`]`(n)` steps). Tests shorten it.
    pub fn set_reconnect_backoff_unit(&self, unit: Duration) {
        *self.inner.reconnect_unit.lock().expect(CONFIG_LOCK) = unit;
    }

    /// Everything a connect needs, resolved before anything is announced:
    /// an unknown profile or a broken route fails here, quietly.
    fn prepare(
        &self,
        session_id: SessionId,
        profile_id: ProfileId,
        credentials: Credentials,
        interactive: bool,
    ) -> CoreResult<Pending> {
        let profile = self.inner.profiles.get(profile_id)?;
        let known_hosts = self.known_hosts_path()?;
        let lookup = |id: ProfileId| self.inner.profiles.get(id);
        let load_config = || self.load_ssh_config();
        let route = Resolver::new(&lookup, &load_config).route(&profile)?;
        let agent = self.inner.agent.lock().expect(CONFIG_LOCK).clone();
        tracing::info!(
            host = %profile.host,
            port = profile.port,
            jumps = route.len() - 1,
            "connecting"
        );

        let Credentials {
            password,
            passphrase,
            remember,
        } = credentials;
        let to_remember = if remember {
            vec![
                (SecretKind::Password, password.clone()),
                (SecretKind::Passphrase, passphrase.clone()),
            ]
        } else {
            Vec::new()
        };
        let target_index = route.len() - 1;
        let hops = route
            .into_iter()
            .enumerate()
            .map(|(index, hop)| {
                let (given_password, given_passphrase) = if index == target_index {
                    (password.clone(), passphrase.clone())
                } else {
                    (None, None)
                };
                self.hop_request(hop, given_password, given_passphrase)
            })
            .collect();

        let generation = self.inner.sessions.next_id();
        let request = ConnectRequest {
            session_id,
            hops,
            agent,
            known_hosts,
            prompts: interactive.then(|| Arc::clone(&self.inner.host_key_prompts)),
            events: self.inner.events.clone(),
            on_closed: self.on_closed(session_id, generation),
        };
        Ok(Pending {
            request,
            profile_id,
            generation,
            to_remember,
        })
    }

    /// Connect, then remember the secrets asked to be remembered.
    async fn establish(&self, pending: Pending) -> CoreResult<LiveSession> {
        let Pending {
            request,
            profile_id,
            generation,
            to_remember,
        } = pending;
        let ssh = SshSession::connect(request).await?;
        for (kind, secret) in to_remember {
            let Some(secret) = secret.filter(|s| !s.is_empty()) else {
                continue;
            };
            // The session is up; a keychain that refuses only means the
            // user is asked again next time.
            if let Err(e) = self.secret_store().set(profile_id, kind, &secret) {
                tracing::warn!(kind = e.kind(), "could not remember a secret");
            }
        }
        Ok(LiveSession {
            profile_id,
            ssh,
            generation,
        })
    }

    /// What connection `generation` of a session does when it ends. It
    /// holds the core weakly: a connection must not keep the core alive.
    fn on_closed(&self, session_id: SessionId, generation: u64) -> OnClosed {
        let core = Arc::downgrade(&self.inner);
        Box::new(move |reason| {
            if let Some(inner) = core.upgrade() {
                Core { inner }.connection_lost(session_id, generation, reason);
            }
        })
    }

    /// Connection `generation` of a session ended without being asked to
    /// (the server closed it, the link died, a call found it gone). Unless
    /// that is old news, the session goes down and — with
    /// `reconnectAttempts` above zero — an automatic reconnect starts.
    fn connection_lost(&self, session_id: SessionId, generation: u64, reason: String) {
        let Some(lost) = self.inner.sessions.mark_lost(session_id, generation) else {
            return;
        };
        tracing::info!("connection lost");
        self.inner.transfers.forget_session(session_id);
        let profile_id = lost.profile_id;
        let runtime = tokio::runtime::Handle::try_current().ok();
        if let Some(runtime) = &runtime {
            // Found gone by a failed call: the connection may still be half
            // open, so close it for good (its own close callback is then old
            // news).
            if !lost.ssh.is_closed() {
                runtime.spawn(async move { lost.ssh.disconnect().await });
            }
        }
        let max = self.settings().reconnect_attempts;
        let run = match runtime {
            Some(runtime) if max > 0 => self
                .inner
                .sessions
                .begin_reconnect(session_id)
                .map(|run| (runtime, run)),
            _ => None,
        };
        match run {
            Some((runtime, run)) => {
                runtime.spawn(
                    self.clone()
                        .auto_reconnect(session_id, run, 1..=max, reason),
                );
            }
            None => self.publish_state(
                session_id,
                profile_id,
                SessionState::Disconnected {
                    reason: Some(reason),
                },
            ),
        }
    }

    /// The `attempts` (of `1..=max`) with backoff ([`reconnect_delay_secs`]),
    /// each a login without prompts (remembered secrets, the agent, key
    /// files). A failure no retry can fix — a secret or a host key decision
    /// is needed, the login or the host key is refused — gives up at once.
    async fn auto_reconnect(
        self,
        session_id: SessionId,
        run: ReconnectRun,
        attempts: std::ops::RangeInclusive<u32>,
        lost_reason: String,
    ) {
        let ReconnectRun {
            run,
            cancel,
            profile_id,
            ..
        } = run;
        let max = *attempts.end();
        let mut last_error = lost_reason;
        for attempt in attempts {
            self.inner
                .sessions
                .note_attempt(session_id, run, attempt, max);
            let secs = reconnect_delay_secs(attempt);
            let reconnecting = |next_retry_in_secs| SessionState::Reconnecting {
                attempt,
                max_attempts: max,
                next_retry_in_secs,
            };
            self.publish_state(session_id, profile_id, reconnecting(secs));
            let wait = self.reconnect_unit().saturating_mul(secs as u32);
            tokio::select! {
                () = cancel.cancelled() => return,
                () = tokio::time::sleep(wait) => {}
            }
            self.publish_state(session_id, profile_id, reconnecting(0));
            let attempt_once = async {
                let pending =
                    self.prepare(session_id, profile_id, Credentials::default(), false)?;
                self.establish(pending).await
            };
            let result = tokio::select! {
                () = cancel.cancelled() => return,
                result = attempt_once => result,
            };
            match result {
                Ok(live) => {
                    self.install(session_id, run, live).await;
                    return;
                }
                Err(e) => {
                    tracing::info!(kind = e.kind(), attempt, "reconnect attempt failed");
                    if let Some(reason) = unrecoverable(&e) {
                        self.give_up(session_id, profile_id, run, reason);
                        return;
                    }
                    last_error = e.to_string();
                }
            }
        }
        let reason = format!("could not reconnect after {max} attempts: {last_error}");
        self.give_up(session_id, profile_id, run, reason);
    }

    fn reconnect_unit(&self) -> Duration {
        *self.inner.reconnect_unit.lock().expect(CONFIG_LOCK)
    }

    /// Put the connection a reconnect run opened in place and carry on with
    /// the session's paused transfers. A run that was overtaken (a newer
    /// one, or a user disconnect) closes its connection instead.
    async fn install(&self, session_id: SessionId, run: u64, live: LiveSession) {
        let profile_id = live.profile_id;
        match self.inner.sessions.finish_reconnect(session_id, run, live) {
            Ok(live) => {
                tracing::info!("reconnected");
                self.publish_state(session_id, profile_id, SessionState::Connected);
                let resumed = self.inner.transfers.resume_paused(session_id);
                tracing::debug!(resumed, "resumed paused transfers");
                if live.ssh.is_closed() {
                    self.connection_lost(session_id, live.generation, LOST.into());
                }
            }
            Err(stale) => stale.ssh.disconnect().await,
        }
    }

    /// A reconnect run ends without a connection: the session is down.
    fn give_up(&self, session_id: SessionId, profile_id: ProfileId, run: u64, reason: String) {
        if self.inner.sessions.give_up(session_id, run) {
            tracing::info!("gave up reconnecting");
            self.publish_state(
                session_id,
                profile_id,
                SessionState::Disconnected {
                    reason: Some(reason),
                },
            );
        }
    }

    /// Attach the secrets one hop may use: what was given, else what its
    /// profile has remembered (read only for the logins that need it).
    fn hop_request(
        &self,
        hop: connection::route::Hop,
        password: Option<Secret>,
        passphrase: Option<Secret>,
    ) -> HopRequest {
        let stored = |kind| hop.profile_id.and_then(|id| self.stored_secret(id, kind));
        let (password, passphrase) = match hop.auth {
            HopAuth::Password => (password.or_else(|| stored(SecretKind::Password)), None),
            HopAuth::KeyFile { .. } | HopAuth::Identities { .. } => {
                (None, passphrase.or_else(|| stored(SecretKind::Passphrase)))
            }
            HopAuth::Agent => (None, None),
        };
        HopRequest {
            hop,
            password,
            passphrase,
        }
    }

    /// Close a session for good: its unfinished transfers are cancelled
    /// (they could never continue), a running reconnect stops, and the id is
    /// forgotten. Idempotent: an unknown or already closed session is not an
    /// error.
    pub async fn disconnect(&self, session_id: SessionId) -> CoreResult<()> {
        self.inner.transfers.cancel_session(session_id);
        self.inner.transfers.forget_session(session_id);
        let Some(removed) = self.inner.sessions.remove(session_id) else {
            return Ok(());
        };
        let profile_id = match removed {
            Removed::Live(live) => {
                live.ssh.disconnect().await;
                live.profile_id
            }
            Removed::NotLive { profile_id } => profile_id,
        };
        self.publish_state(
            session_id,
            profile_id,
            SessionState::Disconnected { reason: None },
        );
        Ok(())
    }

    /// Ids of the sessions with an open connection.
    pub fn sessions(&self) -> Vec<SessionId> {
        self.inner.sessions.ids()
    }

    /// Answer a [`CoreEvent::HostKeyPrompt`]: `trust = true` records the key
    /// in `known_hosts` and lets the connect continue; `false` refuses it.
    /// `InvalidInput` when the prompt is unknown or already closed.
    pub fn answer_host_key(&self, request_id: HostKeyRequestId, trust: bool) -> CoreResult<()> {
        self.inner.host_key_prompts.answer(request_id, trust)
    }

    fn publish_state(&self, session_id: SessionId, profile_id: ProfileId, state: SessionState) {
        self.inner.events.publish(CoreEvent::SessionStateChanged {
            session_id,
            profile_id,
            state,
        });
    }

    // -- Browsing -------------------------------------------------------------

    /// The entries of a folder, unsorted.
    pub async fn list_dir(&self, target: FsTarget, path: &str) -> CoreResult<Vec<Entry>> {
        on_fs!(self, target, |fs| fs.list(path))
    }

    /// One entry (a final symlink is not followed; see [`EntryKind`]).
    pub async fn stat(&self, target: FsTarget, path: &str) -> CoreResult<Entry> {
        on_fs!(self, target, |fs| fs.stat(path))
    }

    /// The raw target text of a symlink.
    pub async fn read_link(&self, target: FsTarget, path: &str) -> CoreResult<String> {
        on_fs!(self, target, |fs| fs.read_link(path))
    }

    /// The user's home folder (local) or login folder (remote), absolute.
    pub async fn home_dir(&self, target: FsTarget) -> CoreResult<String> {
        on_fs!(self, target, |fs| fs.home())
    }

    // -- File operations --------------------------------------------------------

    /// Local deletes go to `trash` (the OS Trash by default; tests install a
    /// fake so they never touch it).
    pub fn set_trash(&self, trash: Arc<dyn Trash>) {
        *self.inner.local.lock().expect(CONFIG_LOCK) = LocalFs::with_trash(trash);
    }

    fn local(&self) -> LocalFs {
        self.inner.local.lock().expect(CONFIG_LOCK).clone()
    }

    /// Create the folder `path`; `AlreadyExists` when the name is taken.
    pub async fn mkdir(&self, target: FsTarget, path: &str) -> CoreResult<()> {
        on_fs!(self, target, |fs| fs.mkdir(path))
    }

    /// Rename `from` to `to` (full paths). Never overwrites:
    /// `AlreadyExists` when `to` is taken.
    pub async fn rename(&self, target: FsTarget, from: &str, to: &str) -> CoreResult<()> {
        on_fs!(self, target, |fs| fs.rename(from, to))
    }

    /// Delete each of `paths` (folders with their contents; symlinks
    /// themselves). Local entries go to the Trash, remote ones are deleted
    /// permanently. A path that fails is reported and the rest carry on; a
    /// lost connection fails the whole call with `NotConnected`.
    pub async fn delete(&self, target: FsTarget, paths: &[String]) -> CoreResult<BatchReport> {
        on_fs!(self, target, |fs| run_batch(paths, |path| async move {
            if is_root(target, path) {
                return Err(CoreError::InvalidInput(format!(
                    "{path} is a root folder and cannot be deleted"
                )));
            }
            fs.remove(path).await
        }))
    }

    /// Set the permission bits of each of `paths` to `mode` (≤ `0o7777`);
    /// with `recursive`, also of everything inside folders (symlinks
    /// skipped). Failures are reported per path, as for [`Core::delete`].
    pub async fn chmod(
        &self,
        target: FsTarget,
        paths: &[String],
        mode: u32,
        recursive: bool,
    ) -> CoreResult<BatchReport> {
        fs::check_mode(mode)?;
        on_fs!(self, target, |fs| run_batch(paths, |path| fs
            .chmod(path, mode, recursive)))
    }

    /// Preview the file at `path`, reading at most `max_bytes` (text at most
    /// [`preview::TEXT_PREVIEW_MAX_BYTES`]).
    pub async fn preview(
        &self,
        target: FsTarget,
        path: &str,
        max_bytes: u64,
    ) -> CoreResult<Preview> {
        on_fs!(self, target, |fs| preview::preview(fs, path, max_bytes))
    }

    /// A remote call that found the connection gone reports it, so the
    /// session is reconnected (or shown as disconnected) instead of kept
    /// around dead.
    fn forget_if_lost<T>(
        &self,
        session_id: SessionId,
        generation: u64,
        result: CoreResult<T>,
    ) -> CoreResult<T> {
        if matches!(result, Err(CoreError::NotConnected)) {
            self.connection_lost(session_id, generation, LOST.into());
        }
        result
    }

    // -- Transfers ----------------------------------------------------------------

    /// Queue an upload or download of `request.items` into
    /// `request.dst_dir`; returns the batch id at once (folders are expanded
    /// in the background, announced with [`CoreEvent::TransfersUpdated`]).
    /// `NotConnected` for an unknown session, `InvalidInput` for an empty
    /// request. Must be called within a Tokio runtime.
    pub fn enqueue_transfers(&self, request: TransferRequest) -> CoreResult<BatchId> {
        self.inner.transfers.enqueue(request)
    }

    /// Cancel one job (a running one leaves its partial file). `NotFound`
    /// for an unknown job; a finished job is left alone.
    pub fn cancel_transfer(&self, job_id: TransferId) -> CoreResult<()> {
        self.inner.transfers.cancel(job_id)
    }

    /// Cancel every unfinished job of a batch. `NotFound` for an unknown
    /// batch.
    pub fn cancel_batch(&self, batch_id: BatchId) -> CoreResult<()> {
        self.inner.transfers.cancel_batch(batch_id)
    }

    /// Answer a [`CoreEvent::TransferConflict`]; with `apply_to_all` the
    /// answer decides the rest of the batch's conflicts too.
    pub fn resolve_conflict(
        &self,
        job_id: TransferId,
        resolution: ConflictResolution,
        apply_to_all: bool,
    ) -> CoreResult<()> {
        self.inner
            .transfers
            .resolve_conflict(job_id, resolution, apply_to_all)
    }

    /// Every transfer job and the totals.
    pub fn list_transfers(&self) -> TransferList {
        self.inner.transfers.list()
    }

    /// Drop finished jobs from the list.
    pub fn clear_finished_transfers(&self) {
        self.inner.transfers.clear_finished();
    }

    /// Whether any transfer is queued, running, waiting for a conflict
    /// answer or paused.
    pub fn has_active_transfers(&self) -> bool {
        self.inner.transfers.has_active()
    }

    /// Queue a failed job again: a file is copied anew from the first byte,
    /// a folder whose listing failed is listed again. `NotFound` for an
    /// unknown job, `InvalidInput` when it has not failed, `NotConnected`
    /// when its session is not connected.
    pub fn retry_transfer(&self, job_id: TransferId) -> CoreResult<()> {
        self.inner.transfers.retry(job_id)
    }

    /// Cancel every unfinished transfer (the user confirmed quitting while
    /// work was in flight). Afterwards [`Core::has_active_work`] is false
    /// once running jobs have stopped their current chunk.
    pub fn cancel_all_transfers(&self) {
        self.inner.transfers.cancel_all();
    }

    /// Continue the jobs that paused when `session_id`'s connection
    /// dropped (appending to their partial files). Returns how many. A
    /// reconnect does this by itself.
    pub fn resume_paused(&self, session_id: SessionId) -> usize {
        self.inner.transfers.resume_paused(session_id)
    }

    /// Continue the jobs paused on `paused_on` over `resume_on`, the
    /// session a reconnect opened. Returns how many.
    pub fn resume_paused_on(&self, paused_on: SessionId, resume_on: SessionId) -> usize {
        self.inner.transfers.resume_paused_on(paused_on, resume_on)
    }

    // -- App lifecycle ----------------------------------------------------------

    /// Whether quitting now would interrupt work the user cares about. The
    /// shell's close/exit guard asks this before letting the window close:
    /// any transfer that is queued, running, waiting for a conflict answer
    /// or paused. Open sessions alone are not work in progress.
    pub fn has_active_work(&self) -> bool {
        self.has_active_transfers()
    }
}

/// What a connect resolved up front, carried to [`Core::establish`].
struct Pending {
    request: ConnectRequest,
    profile_id: ProfileId,
    generation: u64,
    to_remember: Vec<(SecretKind, Option<Secret>)>,
}

/// Why a session went down when a call found its connection gone.
const LOST: &str = "the connection was lost";

/// Backoff before reconnect attempt `attempt` (1-based), in steps of the
/// reconnect unit (seconds): 1, 2, 4, 8, then 16 for every later attempt.
pub fn reconnect_delay_secs(attempt: u32) -> u64 {
    1 << attempt.saturating_sub(1).min(4)
}

/// The reason to stop reconnecting after `err`, when trying again cannot
/// help: the login needs a secret or a host key decision nobody is there to
/// give, or the server refused what Iris has. `None` for failures worth
/// another attempt (unreachable, refused, timed out, …).
fn unrecoverable(err: &CoreError) -> Option<String> {
    match err {
        CoreError::PasswordRequired => {
            Some("reconnecting needs the password; use Retry to enter it".into())
        }
        CoreError::PassphraseRequired => {
            Some("reconnecting needs the key passphrase; use Retry to enter it".into())
        }
        CoreError::HostKeyRejected => Some(
            "the server's host key is not in known_hosts any more; use Retry to check it".into(),
        ),
        CoreError::AuthFailed => {
            Some("the server refused the saved login; use Retry to log in again".into())
        }
        CoreError::HostKeyChanged { .. }
        | CoreError::KeyFile(_)
        | CoreError::Agent(_)
        | CoreError::Keychain(_)
        | CoreError::NotFound(_)
        | CoreError::Config(_)
        | CoreError::InvalidInput(_) => Some(err.to_string()),
        _ => None,
    }
}

/// The transfer slots the settings ask for.
fn parallelism(settings: &IrisSettings) -> usize {
    usize::try_from(settings.parallel_transfers).unwrap_or(1)
}

/// Apply `op` to each path in turn, collecting failures instead of
/// stopping. A lost connection ends the batch: nothing after it can work.
async fn run_batch<'a, F, Fut>(paths: &'a [String], mut op: F) -> CoreResult<BatchReport>
where
    F: FnMut(&'a str) -> Fut,
    Fut: Future<Output = CoreResult<()>>,
{
    let mut report = BatchReport::default();
    for path in paths {
        match op(path).await {
            Ok(()) => report.succeeded.push(path.clone()),
            Err(CoreError::NotConnected) => return Err(CoreError::NotConnected),
            Err(e) => report.failed.push(BatchFailure {
                path: path.clone(),
                kind: e.kind().to_string(),
                message: e.to_string(),
            }),
        }
    }
    Ok(report)
}

/// Whether `path` is a filesystem root (or empty), which Iris never deletes.
fn is_root(target: FsTarget, path: &str) -> bool {
    match target {
        FsTarget::Local => Path::new(path).parent().is_none(),
        FsTarget::Remote { .. } => path.trim_end_matches('/').is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_settings_announces_the_change() {
        let core = Core::new();
        let mut rx = core.subscribe_events();
        core.save_settings(IrisSettings::default()).unwrap();
        assert_eq!(rx.try_recv().unwrap(), CoreEvent::SettingsChanged);
    }

    #[test]
    fn a_rejected_save_announces_nothing() {
        let core = Core::new();
        let mut rx = core.subscribe_events();
        let bad = IrisSettings {
            parallel_transfers: 0,
            ..IrisSettings::default()
        };
        assert!(core.save_settings(bad).is_err());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn the_reconnect_backoff_doubles_up_to_sixteen_seconds() {
        let delays: Vec<u64> = (1..=8).map(reconnect_delay_secs).collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16, 16, 16, 16]);
        assert_eq!(reconnect_delay_secs(0), 1);
        assert_eq!(reconnect_delay_secs(u32::MAX), 16);
    }

    #[test]
    fn only_failures_a_retry_can_fix_keep_reconnecting() {
        for err in [
            CoreError::ConnectFailed("connection refused".into()),
            CoreError::NotConnected,
            CoreError::Remote("x".into()),
            CoreError::JumpHost("bastion could not reach sftp.example.test:22".into()),
        ] {
            assert_eq!(unrecoverable(&err), None, "{err:?}");
        }
        for err in [
            CoreError::PasswordRequired,
            CoreError::PassphraseRequired,
            CoreError::AuthFailed,
            CoreError::HostKeyRejected,
            CoreError::HostKeyChanged {
                host: "sftp.example.test".into(),
                port: 22,
            },
            CoreError::KeyFile("the file does not exist".into()),
            CoreError::Agent("no SSH agent is running".into()),
            CoreError::NotFound("connection".into()),
        ] {
            assert!(unrecoverable(&err).is_some(), "{err:?}");
        }
    }

    #[tokio::test]
    async fn reconnecting_an_unknown_session_is_not_connected() {
        let core = Core::new();
        let err = core
            .reconnect(SessionId::new(), Credentials::default())
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "notConnected");
    }

    #[test]
    fn nothing_is_active_without_transfers() {
        let core = Core::new();
        assert!(!core.has_active_work());
        assert!(!core.has_active_transfers());
        assert!(core.list_transfers().jobs.is_empty());
    }

    #[test]
    fn transfer_calls_on_unknown_jobs_are_not_found() {
        let core = Core::new();
        assert_eq!(
            core.cancel_transfer(TransferId::new()).unwrap_err().kind(),
            "notFound"
        );
        assert_eq!(
            core.cancel_batch(BatchId::new()).unwrap_err().kind(),
            "notFound"
        );
        let err = core
            .resolve_conflict(TransferId::new(), ConflictResolution::Skip, true)
            .unwrap_err();
        assert_eq!(err.kind(), "notFound");
        assert_eq!(core.resume_paused(SessionId::new()), 0);
    }

    #[tokio::test]
    async fn transfers_need_a_live_session() {
        let core = Core::new();
        let err = core
            .enqueue_transfers(TransferRequest {
                session_id: SessionId::new(),
                direction: TransferDirection::Download,
                items: vec![TransferItem { src: "/a".into() }],
                dst_dir: "/tmp".into(),
            })
            .unwrap_err();
        assert_eq!(err.kind(), "notConnected");
    }

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: ProfileId::new(),
            name: "Example".into(),
            host: "sftp.example.test".into(),
            port: 22,
            user: "demo".into(),
            auth: AuthMethod::Password,
            start_dir: None,
            jump: None,
        }
    }

    #[test]
    fn saving_and_deleting_profiles_announce_the_change() {
        let core = Core::new();
        let mut rx = core.subscribe_events();
        let saved = core.save_profile(profile()).unwrap();
        assert_eq!(rx.try_recv().unwrap(), CoreEvent::ProfilesChanged);
        assert_eq!(core.list_profiles(), vec![saved.clone()]);
        core.delete_profile(saved.id).unwrap();
        assert_eq!(rx.try_recv().unwrap(), CoreEvent::ProfilesChanged);
        assert!(core.list_profiles().is_empty());
    }

    #[test]
    fn a_rejected_profile_announces_nothing() {
        let core = Core::new();
        let mut rx = core.subscribe_events();
        let bad = ConnectionProfile {
            user: String::new(),
            ..profile()
        };
        assert!(core.save_profile(bad).is_err());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn connect_needs_a_known_profile() {
        let core = Core::new();
        core.set_known_hosts_path(PathBuf::from("/nonexistent/known_hosts"));
        let err = core
            .connect(ProfileId::new(), None, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "notFound");
    }

    #[tokio::test]
    async fn connect_refuses_without_a_known_hosts_location() {
        let core = Core::new();
        let saved = core.save_profile(profile()).unwrap();
        let err = core.connect(saved.id, None, None).await.unwrap_err();
        assert_eq!(err.kind(), "config");
    }

    #[tokio::test]
    async fn remote_calls_on_unknown_sessions_are_not_connected() {
        let core = Core::new();
        let target = FsTarget::Remote {
            session_id: SessionId::new(),
        };
        assert!(matches!(
            core.list_dir(target, "/").await,
            Err(CoreError::NotConnected)
        ));
        assert!(matches!(
            core.home_dir(target).await,
            Err(CoreError::NotConnected)
        ));
        // Disconnecting an unknown session is a no-op.
        core.disconnect(SessionId::new()).await.unwrap();
    }

    #[tokio::test]
    async fn local_targets_go_to_the_local_disk() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let core = Core::new();
        let entries = core
            .list_dir(FsTarget::Local, &dir.path().to_string_lossy())
            .await
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a.txt");
    }
}
