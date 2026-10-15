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
//! Phase 0 holds only the app plumbing: persisted [`IrisSettings`], the event
//! bus, and the close guard's [`Core::has_active_work`]. Connections, remote
//! browsing and transfers arrive in later phases.

#![forbid(unsafe_code)]

pub mod error;
pub mod events;
pub mod ids;
pub mod settings;

use std::path::PathBuf;

use tokio::sync::broadcast;

pub use error::{CoreError, CoreResult};
pub use events::{CoreEvent, EventBus};
pub use settings::{IrisSettings, IrisSettingsStore};

/// The application's single entry point.
///
/// Cheap to share: hold it behind an `Arc` in the shell and clone the handle
/// into any detached task. Interior mutability keeps the public API `&self`,
/// so callers never need a mutable borrow.
#[derive(Default)]
pub struct Core {
    events: EventBus,
    settings: IrisSettingsStore,
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

    /// Whether quitting now would interrupt work the user cares about. The
    /// shell's close/exit guard asks this before letting the window close.
    ///
    /// Always `false` in Phase 0: there is nothing to interrupt yet. Phase 5
    /// wires it to the transfer queue (any queued or running transfer).
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
    fn nothing_is_active_in_phase_0() {
        assert!(!Core::new().has_active_work());
    }
}
