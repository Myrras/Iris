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
//! [`ConnectionProfile`]s, the live SSH/SFTP sessions and the
//! [`FileSystem`] calls the browsing panes make against either side
//! ([`FsTarget`]). Transfers arrive in a later phase.

#![forbid(unsafe_code)]

pub mod connection;
pub mod error;
pub mod events;
pub mod fs;
pub mod ids;
mod persist;
pub mod secret;
pub mod session_manager;
pub mod settings;
pub mod ssh;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::broadcast;

pub use connection::{AuthMethod, ConnectionProfile, ProfileStore};
pub use error::{CoreError, CoreResult};
pub use events::{CoreEvent, EventBus, SessionState};
pub use fs::{Entry, EntryKind, FileSystem, FsTarget, LinkTargetKind, LocalFs};
pub use ids::{HostKeyRequestId, ProfileId, SessionId};
pub use secret::Secret;
pub use settings::{IrisSettings, IrisSettingsStore};

use session_manager::SessionManager;
use ssh::hostkey::HostKeyPrompts;
use ssh::{ConnectRequest, SshSession};

/// The application's single entry point.
///
/// Cheap to share: hold it behind an `Arc` in the shell and clone the handle
/// into any detached task. Interior mutability keeps the public API `&self`,
/// so callers never need a mutable borrow.
#[derive(Default)]
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
    local: LocalFs,
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

    /// Delete a saved connection (`NotFound` if unknown), then announce
    /// [`CoreEvent::ProfilesChanged`]. Open sessions from it stay open.
    pub fn delete_profile(&self, id: ProfileId) -> CoreResult<()> {
        self.profiles.delete(id)?;
        self.events.publish(CoreEvent::ProfilesChanged);
        Ok(())
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

    /// Open a session for a saved connection: connect, verify the host key
    /// (an unknown key raises [`CoreEvent::HostKeyPrompt`] and waits for
    /// [`Core::answer_host_key`]), authenticate, open SFTP.
    ///
    /// `password` is required for password profiles; `passphrase` is only
    /// needed for an encrypted key file (`PassphraseRequired` otherwise).
    /// Neither is kept after authentication.
    ///
    /// Announces [`SessionState::Connecting`] first, then `Connected` or a
    /// `Disconnected` carrying the error text.
    pub async fn connect(
        &self,
        profile_id: ProfileId,
        password: Option<Secret>,
        passphrase: Option<Secret>,
    ) -> CoreResult<SessionId> {
        let profile = self.profiles.get(profile_id)?;
        let known_hosts = self.known_hosts_path()?;
        let session_id = SessionId::new();
        self.publish_state(session_id, profile_id, SessionState::Connecting, None);
        tracing::info!(host = %profile.host, port = profile.port, "connecting");

        let request = ConnectRequest {
            session_id,
            host: profile.host,
            port: profile.port,
            user: profile.user,
            auth: profile.auth,
            password,
            passphrase,
            known_hosts,
            prompts: Arc::clone(&self.host_key_prompts),
            events: self.events.clone(),
            on_closed: self
                .sessions
                .on_closed(session_id, profile_id, self.events.clone()),
        };
        match SshSession::connect(request).await {
            Ok(ssh) => {
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
        match target {
            FsTarget::Local => self.local.list(path).await,
            FsTarget::Remote { session_id } => {
                let live = self.sessions.get(session_id)?;
                let result = live.ssh.fs().list(path).await;
                self.forget_if_lost(session_id, live.profile_id, result)
            }
        }
    }

    /// One entry (a final symlink is not followed; see [`EntryKind`]).
    pub async fn stat(&self, target: FsTarget, path: &str) -> CoreResult<Entry> {
        match target {
            FsTarget::Local => self.local.stat(path).await,
            FsTarget::Remote { session_id } => {
                let live = self.sessions.get(session_id)?;
                let result = live.ssh.fs().stat(path).await;
                self.forget_if_lost(session_id, live.profile_id, result)
            }
        }
    }

    /// The raw target text of a symlink.
    pub async fn read_link(&self, target: FsTarget, path: &str) -> CoreResult<String> {
        match target {
            FsTarget::Local => self.local.read_link(path).await,
            FsTarget::Remote { session_id } => {
                let live = self.sessions.get(session_id)?;
                let result = live.ssh.fs().read_link(path).await;
                self.forget_if_lost(session_id, live.profile_id, result)
            }
        }
    }

    /// The user's home folder (local) or login folder (remote), absolute.
    pub async fn home_dir(&self, target: FsTarget) -> CoreResult<String> {
        match target {
            FsTarget::Local => self.local.home().await,
            FsTarget::Remote { session_id } => {
                let live = self.sessions.get(session_id)?;
                let result = live.ssh.fs().home().await;
                self.forget_if_lost(session_id, live.profile_id, result)
            }
        }
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
