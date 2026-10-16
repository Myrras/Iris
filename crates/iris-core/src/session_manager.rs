//! The sessions, by [`SessionId`], and where each one is in its life.
//!
//! A session id outlives its SSH connection: when a connection drops
//! unexpectedly the id stays registered while Iris reconnects (or after it
//! gave up), so the UI and the transfer jobs keep referring to the same
//! session and need no remapping once a new connection takes its place. Only
//! a user disconnect forgets the id.
//!
//! Each entry is in one of three slots:
//!
//! - **Live**: an open connection ([`LiveSession`]). Its `generation` tells
//!   it apart from earlier and later connections of the same session, so a
//!   close callback of an old connection never touches a newer one.
//! - **Reconnecting**: a reconnect run (automatic or manual) is under way;
//!   `run` identifies it, so only that run may install its connection, and
//!   `cancel` stops it (a user disconnect, or a newer run taking over). An
//!   automatic run records which attempt it is at, so a manual "Retry now"
//!   that takes over and fails can carry on with the attempts left.
//! - **Down**: the connection is gone and nothing is retrying; a manual
//!   reconnect may revive it.
//!
//! All transitions happen under one lock and never across an `.await`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use crate::error::{CoreError, CoreResult};
use crate::ids::{ProfileId, SessionId};
use crate::ssh::SshSession;

const LOCK_POISONED: &str = "session map lock poisoned";

/// One open connection of a session and the profile it was opened from.
pub struct LiveSession {
    pub profile_id: ProfileId,
    pub ssh: SshSession,
    /// Which connection of the session this is (see the module docs).
    pub generation: u64,
}

/// A reconnect run's handle: its id and how to stop it.
#[derive(Clone)]
pub struct ReconnectRun {
    pub run: u64,
    pub cancel: CancellationToken,
    pub profile_id: ProfileId,
    /// The automatic run this one took over, as `(attempt, max_attempts)`:
    /// the attempt it was waiting for or running. `None` when the session
    /// was down (or a manual run was under way).
    pub interrupted: Option<(u32, u32)>,
}

enum Slot {
    Live(Arc<LiveSession>),
    Reconnecting {
        run: u64,
        cancel: CancellationToken,
        /// `(attempt, max_attempts)` of an automatic run.
        attempt: Option<(u32, u32)>,
    },
    Down,
}

struct Entry {
    profile_id: ProfileId,
    slot: Slot,
}

/// What a user disconnect took out of the map.
pub enum Removed {
    Live(Arc<LiveSession>),
    /// A reconnect was running (it has been cancelled) or the session was
    /// already down: there is no connection to close.
    NotLive {
        profile_id: ProfileId,
    },
}

type SessionMap = HashMap<SessionId, Entry>;

/// Cloning shares the same map (the transfer engine holds a clone).
#[derive(Default, Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<SessionMap>>,
    /// Source of connection generations and reconnect run ids.
    counter: Arc<AtomicU64>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// A fresh connection generation or run id.
    pub fn next_id(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SessionMap> {
        self.sessions.lock().expect(LOCK_POISONED)
    }

    /// Register a freshly connected (new) session.
    pub fn insert(&self, session_id: SessionId, live: LiveSession) {
        let profile_id = live.profile_id;
        self.lock().insert(
            session_id,
            Entry {
                profile_id,
                slot: Slot::Live(Arc::new(live)),
            },
        );
    }

    /// The live session, or `NotConnected` (also while reconnecting). The
    /// lock is released before the caller awaits anything on it.
    pub fn get(&self, session_id: SessionId) -> CoreResult<Arc<LiveSession>> {
        match self.lock().get(&session_id).map(|e| &e.slot) {
            Some(Slot::Live(live)) => Ok(Arc::clone(live)),
            _ => Err(CoreError::NotConnected),
        }
    }

    /// Whether the session is registered at all (live, reconnecting or
    /// down).
    pub fn is_known(&self, session_id: SessionId) -> bool {
        self.lock().contains_key(&session_id)
    }

    /// Forget a session (a user disconnect). A running reconnect is
    /// cancelled. `None` when it was not registered.
    pub fn remove(&self, session_id: SessionId) -> Option<Removed> {
        let entry = self.lock().remove(&session_id)?;
        Some(match entry.slot {
            Slot::Live(live) => Removed::Live(live),
            Slot::Reconnecting { cancel, .. } => {
                cancel.cancel();
                Removed::NotLive {
                    profile_id: entry.profile_id,
                }
            }
            Slot::Down => Removed::NotLive {
                profile_id: entry.profile_id,
            },
        })
    }

    /// Ids of the sessions with an open connection.
    pub fn ids(&self) -> Vec<SessionId> {
        self.lock()
            .iter()
            .filter(|(_, e)| matches!(e.slot, Slot::Live(_)))
            .map(|(id, _)| *id)
            .collect()
    }

    /// Connection `generation` of the session ended: if it is still the
    /// live one, the session goes down. Returns that connection then, `None`
    /// when the loss is old news (a user disconnect, or a newer connection
    /// already took over).
    pub fn mark_lost(&self, session_id: SessionId, generation: u64) -> Option<Arc<LiveSession>> {
        let mut map = self.lock();
        let entry = map.get_mut(&session_id)?;
        match &entry.slot {
            Slot::Live(live) if live.generation == generation => {
                let live = Arc::clone(live);
                entry.slot = Slot::Down;
                Some(live)
            }
            _ => None,
        }
    }

    /// Start a reconnect run for a session that is not live, cancelling any
    /// run already under way. `None` when the session is live or unknown.
    pub fn begin_reconnect(&self, session_id: SessionId) -> Option<ReconnectRun> {
        let mut map = self.lock();
        let entry = map.get_mut(&session_id)?;
        let interrupted = match &entry.slot {
            Slot::Live(_) => return None,
            Slot::Reconnecting {
                cancel, attempt, ..
            } => {
                cancel.cancel();
                *attempt
            }
            Slot::Down => None,
        };
        let run = self.next_id();
        let cancel = CancellationToken::new();
        entry.slot = Slot::Reconnecting {
            run,
            cancel: cancel.clone(),
            attempt: None,
        };
        Some(ReconnectRun {
            run,
            cancel,
            profile_id: entry.profile_id,
            interrupted,
        })
    }

    /// An automatic run moved on to `attempt` of `max`. Ignored when the
    /// run is no longer current.
    pub fn note_attempt(&self, session_id: SessionId, run: u64, attempt: u32, max: u32) {
        let mut map = self.lock();
        if let Some(Entry {
            slot:
                Slot::Reconnecting {
                    run: current,
                    attempt: noted,
                    ..
                },
            ..
        }) = map.get_mut(&session_id)
        {
            if *current == run {
                *noted = Some((attempt, max));
            }
        }
    }

    /// Install the connection a reconnect run opened. Hands it back when the
    /// run is no longer current (cancelled, superseded, or the session was
    /// disconnected meanwhile), so the caller can close it.
    pub fn finish_reconnect(
        &self,
        session_id: SessionId,
        run: u64,
        live: LiveSession,
    ) -> Result<Arc<LiveSession>, LiveSession> {
        let mut map = self.lock();
        let Some(entry) = map.get_mut(&session_id) else {
            return Err(live);
        };
        match &entry.slot {
            Slot::Reconnecting { run: current, .. } if *current == run => {
                let live = Arc::new(live);
                entry.slot = Slot::Live(Arc::clone(&live));
                Ok(live)
            }
            _ => Err(live),
        }
    }

    /// A reconnect run gave up: the session goes down. `false` when the run
    /// is no longer current (nothing changes then).
    pub fn give_up(&self, session_id: SessionId, run: u64) -> bool {
        let mut map = self.lock();
        let Some(entry) = map.get_mut(&session_id) else {
            return false;
        };
        match &entry.slot {
            Slot::Reconnecting { run: current, .. } if *current == run => {
                entry.slot = Slot::Down;
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_sessions_are_not_connected_and_not_reconnectable() {
        let sessions = SessionManager::new();
        let id = SessionId::new();
        assert!(matches!(sessions.get(id), Err(CoreError::NotConnected)));
        assert!(sessions.begin_reconnect(id).is_none());
        assert!(sessions.mark_lost(id, 1).is_none());
        assert!(sessions.remove(id).is_none());
        assert!(!sessions.is_known(id));
    }

    #[test]
    fn a_run_taking_over_learns_where_the_automatic_one_was() {
        let sessions = SessionManager::new();
        let id = SessionId::new();
        sessions.lock().insert(
            id,
            Entry {
                profile_id: ProfileId::new(),
                slot: Slot::Down,
            },
        );
        let auto = sessions.begin_reconnect(id).unwrap();
        assert_eq!(auto.interrupted, None);
        sessions.note_attempt(id, auto.run, 2, 5);
        // A stale run's progress is ignored.
        sessions.note_attempt(id, auto.run + 100, 4, 5);
        let manual = sessions.begin_reconnect(id).unwrap();
        assert!(auto.cancel.is_cancelled());
        assert_eq!(manual.interrupted, Some((2, 5)));
        // The manual run itself records nothing, so a second takeover
        // starts from scratch.
        assert_eq!(sessions.begin_reconnect(id).unwrap().interrupted, None);
    }

    #[test]
    fn ids_are_unique_and_increasing() {
        let sessions = SessionManager::new();
        let a = sessions.next_id();
        let b = sessions.next_id();
        assert!(b > a);
    }
}
