//! The live sessions, by [`SessionId`].
//!
//! Minimal for Phase 1: a map from id to the open [`SshSession`]. The map is
//! shared with each connection's close callback, so a connection that drops
//! on its own removes itself and announces
//! [`SessionState::Disconnected`] exactly once. A user-initiated disconnect
//! removes the entry first, which makes the callback a no-op.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::error::{CoreError, CoreResult};
use crate::events::{CoreEvent, EventBus, SessionState};
use crate::ids::{ProfileId, SessionId};
use crate::ssh::session::OnClosed;
use crate::ssh::SshSession;

const LOCK_POISONED: &str = "session map lock poisoned";

/// One open session and the profile it was opened from.
pub struct LiveSession {
    pub profile_id: ProfileId,
    pub ssh: SshSession,
}

type SessionMap = HashMap<SessionId, Arc<LiveSession>>;

/// Cloning shares the same map (the transfer engine holds a clone).
#[derive(Default, Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<SessionMap>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a freshly connected session.
    pub fn insert(&self, session_id: SessionId, profile_id: ProfileId, ssh: SshSession) {
        self.sessions
            .lock()
            .expect(LOCK_POISONED)
            .insert(session_id, Arc::new(LiveSession { profile_id, ssh }));
    }

    /// The live session, or `NotConnected`. The lock is released before the
    /// caller awaits anything on it.
    pub fn get(&self, session_id: SessionId) -> CoreResult<Arc<LiveSession>> {
        self.sessions
            .lock()
            .expect(LOCK_POISONED)
            .get(&session_id)
            .cloned()
            .ok_or(CoreError::NotConnected)
    }

    /// Take a session out of the map; `None` when it was already gone.
    pub fn remove(&self, session_id: SessionId) -> Option<Arc<LiveSession>> {
        self.sessions
            .lock()
            .expect(LOCK_POISONED)
            .remove(&session_id)
    }

    /// Ids of all open sessions.
    pub fn ids(&self) -> Vec<SessionId> {
        self.sessions
            .lock()
            .expect(LOCK_POISONED)
            .keys()
            .copied()
            .collect()
    }

    /// The callback a connection runs when it ends: if the session is still
    /// registered, drop it and announce the disconnect with `reason`.
    pub fn on_closed(
        &self,
        session_id: SessionId,
        profile_id: ProfileId,
        events: EventBus,
    ) -> OnClosed {
        let sessions = Arc::clone(&self.sessions);
        Box::new(move |reason| {
            let removed = sessions.lock().expect(LOCK_POISONED).remove(&session_id);
            if removed.is_some() {
                events.publish(CoreEvent::SessionStateChanged {
                    session_id,
                    profile_id,
                    state: SessionState::Disconnected,
                    reason: Some(reason),
                });
            }
        })
    }
}
