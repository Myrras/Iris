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
//! ssh-agent and `~/.ssh/config` logins and jump hosts. Transfers arrive in
//! a later phase.

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

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;

pub use connection::{AuthMethod, ConnectionProfile, JumpHost, ProfileStore};
pub use error::{CoreError, CoreResult};
pub use events::{CoreEvent, EventBus, SessionState};
pub use fs::{
    BatchFailure, BatchReport, Entry, EntryKind, FileSystem, FsTarget, LinkTargetKind, LocalFs,
    SystemTrash, Trash,
};
pub use ids::{HostKeyRequestId, ProfileId, SessionId};
pub use preview::Preview;
pub use secret::Secret;
pub use secrets::{KeychainStore, MemorySecretStore, SecretKind, SecretStore};
pub use settings::{IrisSettings, IrisSettingsStore};
pub use ssh::AgentLocation;
pub use ssh_config::SshConfigHost;

use connection::route::{HopAuth, Resolver};
use session_manager::SessionManager;
use ssh::hostkey::HostKeyPrompts;
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
/// Cheap to share: hold it behind an `Arc` in the shell and clone the handle
/// into any detached task. Interior mutability keeps the public API `&self`,
/// so callers never need a mutable borrow.
pub struct Core {
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
}

impl Default for Core {
    fn default() -> Self {
        Self {
            events: EventBus::default(),
            settings: IrisSettingsStore::default(),
            profiles: ProfileStore::default(),
            sessions: SessionManager::default(),
            host_key_prompts: Arc::default(),
            known_hosts: Mutex::default(),
            ssh_config: Mutex::default(),
            agent: Mutex::default(),
            secrets: Mutex::new(Arc::new(MemorySecretStore::new())),
            local: Mutex::new(LocalFs::new()),
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
                let live = $core.sessions.get(session_id)?;
                let $fs = live.ssh.fs();
                let result = $call.await;
                $core.forget_if_lost(session_id, live.profile_id, result)
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
        self.events.subscribe()
    }

    /// Back the settings with `path` (normally `{app_data_dir}/settings.json`)
    /// and load it. Until this is called the settings are in-memory only.
    pub fn set_settings_path(&self, path: PathBuf) {
        self.settings.set_path(path);
    }

    /// The current settings.
    pub fn settings(&self) -> IrisSettings {
        self.settings.get()
    }

    /// Validate and persist `settings`, then announce
    /// [`CoreEvent::SettingsChanged`]. Returns what was stored (normalized).
    pub fn save_settings(&self, settings: IrisSettings) -> CoreResult<IrisSettings> {
        let saved = self.settings.save(settings)?;
        self.events.publish(CoreEvent::SettingsChanged);
        Ok(saved)
    }

    // -- Connection profiles ------------------------------------------------

    /// Back the saved connections with `path` (normally
    /// `{app_data_dir}/profiles.json`) and load it. Until this is called the
    /// profiles are in-memory only.
    pub fn set_profiles_path(&self, path: PathBuf) {
        self.profiles.set_path(path);
    }

    /// All saved connections, in the order they were created.
    pub fn list_profiles(&self) -> Vec<ConnectionProfile> {
        self.profiles.list()
    }

    /// Validate and store (insert or replace by id) a connection, then
    /// announce [`CoreEvent::ProfilesChanged`]. Returns what was stored.
    pub fn save_profile(&self, profile: ConnectionProfile) -> CoreResult<ConnectionProfile> {
        let saved = self.profiles.save(profile)?;
        self.events.publish(CoreEvent::ProfilesChanged);
        Ok(saved)
    }

    /// Delete a saved connection (`NotFound` if unknown) and its remembered
    /// secrets, then announce [`CoreEvent::ProfilesChanged`]. Open sessions
    /// from it stay open; a connection that used it as its jump host reports
    /// that on its next connect.
    pub fn delete_profile(&self, id: ProfileId) -> CoreResult<()> {
        self.profiles.delete(id)?;
        let store = self.secret_store();
        for kind in SecretKind::ALL {
            // The profile is gone either way; a keychain that refuses now
            // only leaves an orphaned entry behind.
            if let Err(e) = store.delete(id, kind) {
                tracing::warn!(kind = e.kind(), "could not delete a saved secret");
            }
        }
        self.events.publish(CoreEvent::ProfilesChanged);
        Ok(())
    }

    // -- Secrets ----------------------------------------------------------------

    /// Keep remembered secrets in `store` (the shell installs
    /// [`KeychainStore`]; the default is in memory).
    pub fn set_secret_store(&self, store: Arc<dyn SecretStore>) {
        *self.secrets.lock().expect(CONFIG_LOCK) = store;
    }

    fn secret_store(&self) -> Arc<dyn SecretStore> {
        Arc::clone(&self.secrets.lock().expect(CONFIG_LOCK))
    }

    /// Remember `value` as the `kind` secret of a saved connection
    /// (`NotFound` if the profile is unknown).
    pub fn set_secret(
        &self,
        profile_id: ProfileId,
        kind: SecretKind,
        value: Secret,
    ) -> CoreResult<()> {
        self.profiles.get(profile_id)?;
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
        *self.ssh_config.lock().expect(CONFIG_LOCK) = Some(path);
    }

    fn load_ssh_config(&self) -> CoreResult<SshConfigFile> {
        let path = self.ssh_config.lock().expect(CONFIG_LOCK).clone();
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
        *self.agent.lock().expect(CONFIG_LOCK) = Some(location);
    }

    // -- Sessions -------------------------------------------------------------

    /// The `known_hosts` file host keys are verified against and learned
    /// into. The shell sets `~/.ssh/known_hosts`
    /// ([`ssh::hostkey::default_known_hosts_path`]); tests set a temp file.
    pub fn set_known_hosts_path(&self, path: PathBuf) {
        *self.known_hosts.lock().expect("known_hosts lock poisoned") = Some(path);
    }

    fn known_hosts_path(&self) -> CoreResult<PathBuf> {
        self.known_hosts
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
    /// Announces [`SessionState::Connecting`] first, then `Connected` or a
    /// `Disconnected` carrying the error text.
    pub async fn connect_with(
        &self,
        profile_id: ProfileId,
        credentials: Credentials,
    ) -> CoreResult<SessionId> {
        let profile = self.profiles.get(profile_id)?;
        let known_hosts = self.known_hosts_path()?;
        let lookup = |id: ProfileId| self.profiles.get(id);
        let load_config = || self.load_ssh_config();
        let route = Resolver::new(&lookup, &load_config).route(&profile)?;
        let agent = self.agent.lock().expect(CONFIG_LOCK).clone();

        let session_id = SessionId::new();
        self.publish_state(session_id, profile_id, SessionState::Connecting, None);
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

        let request = ConnectRequest {
            session_id,
            hops,
            agent,
            known_hosts,
            prompts: Arc::clone(&self.host_key_prompts),
            events: self.events.clone(),
            on_closed: self
                .sessions
                .on_closed(session_id, profile_id, self.events.clone()),
        };
        match SshSession::connect(request).await {
            Ok(ssh) => {
                for (kind, secret) in to_remember {
                    let Some(secret) = secret.filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    // The session is up; a keychain that refuses only means
                    // the user is asked again next time.
                    if let Err(e) = self.secret_store().set(profile_id, kind, &secret) {
                        tracing::warn!(kind = e.kind(), "could not remember a secret");
                    }
                }
                self.sessions.insert(session_id, profile_id, ssh);
                self.publish_state(session_id, profile_id, SessionState::Connected, None);
                Ok(session_id)
            }
            Err(e) => {
                tracing::info!(kind = e.kind(), "connect failed");
                self.publish_state(
                    session_id,
                    profile_id,
                    SessionState::Disconnected,
                    Some(e.to_string()),
                );
                Err(e)
            }
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

    /// Close a session. Idempotent: an unknown or already closed session is
    /// not an error.
    pub async fn disconnect(&self, session_id: SessionId) -> CoreResult<()> {
        if let Some(live) = self.sessions.remove(session_id) {
            live.ssh.disconnect().await;
            self.publish_state(
                session_id,
                live.profile_id,
                SessionState::Disconnected,
                None,
            );
        }
        Ok(())
    }

    /// Ids of the open sessions.
    pub fn sessions(&self) -> Vec<SessionId> {
        self.sessions.ids()
    }

    /// Answer a [`CoreEvent::HostKeyPrompt`]: `trust = true` records the key
    /// in `known_hosts` and lets the connect continue; `false` refuses it.
    /// `InvalidInput` when the prompt is unknown or already closed.
    pub fn answer_host_key(&self, request_id: HostKeyRequestId, trust: bool) -> CoreResult<()> {
        self.host_key_prompts.answer(request_id, trust)
    }

    fn publish_state(
        &self,
        session_id: SessionId,
        profile_id: ProfileId,
        state: SessionState,
        reason: Option<String>,
    ) {
        self.events.publish(CoreEvent::SessionStateChanged {
            session_id,
            profile_id,
            state,
            reason,
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
        *self.local.lock().expect(CONFIG_LOCK) = LocalFs::with_trash(trash);
    }

    fn local(&self) -> LocalFs {
        self.local.lock().expect(CONFIG_LOCK).clone()
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

    /// A remote call that found the connection gone drops the session and
    /// announces it, so the UI does not keep a dead session around.
    fn forget_if_lost<T>(
        &self,
        session_id: SessionId,
        profile_id: ProfileId,
        result: CoreResult<T>,
    ) -> CoreResult<T> {
        if matches!(result, Err(CoreError::NotConnected))
            && self.sessions.remove(session_id).is_some()
        {
            self.publish_state(
                session_id,
                profile_id,
                SessionState::Disconnected,
                Some("the connection was lost".into()),
            );
        }
        result
    }

    // -- App lifecycle ----------------------------------------------------------

    /// Whether quitting now would interrupt work the user cares about. The
    /// shell's close/exit guard asks this before letting the window close.
    ///
    /// Always `false` for now: open sessions are not work in progress.
    /// Phase 5 wires it to the transfer queue (any queued or running
    /// transfer).
    pub fn has_active_work(&self) -> bool {
        false
    }
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
    fn nothing_is_active_without_transfers() {
        assert!(!Core::new().has_active_work());
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
