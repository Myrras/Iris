/**
 * Live sessions, fed only by `session:state-changed` events (`useCoreEvents`).
 * Disconnected sessions are kept so a pane can still say why its session
 * ended (and offer Retry); they are few and tiny.
 */

import { create } from "zustand";

import type {
  ProfileId,
  SessionId,
  SessionState,
  SessionStateChangedEvent,
} from "../ipc/types";

export interface SessionInfo {
  sessionId: SessionId;
  profileId: ProfileId;
  /** Includes the disconnect reason / reconnect attempt (`SessionState`). */
  state: SessionState;
}

interface SessionStoreState {
  /** By id, in the order the sessions first appeared. */
  sessions: Record<SessionId, SessionInfo>;
  /** Record a state change; returns the session's state before it. */
  apply: (event: SessionStateChangedEvent) => SessionState | undefined;
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions: {},
  apply: ({ sessionId, profileId, state }) => {
    const previous = get().sessions[sessionId]?.state;
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: { sessionId, profileId, state },
      },
    }));
    return previous;
  },
}));

/** Whether the session can be browsed and transferred over right now. */
export function isConnected(info: SessionInfo | undefined): boolean {
  return info?.state.status === "connected";
}

/** The disconnect reason, when the session ended without being asked to. */
export function disconnectReason(info: SessionInfo | undefined): string | null {
  return info?.state.status === "disconnected" ? info.state.reason : null;
}

/** The most recent session of a profile. */
export function latestSessionFor(
  sessions: Record<SessionId, SessionInfo>,
  profileId: ProfileId,
): SessionInfo | undefined {
  let latest: SessionInfo | undefined;
  for (const info of Object.values(sessions)) {
    if (info.profileId === profileId) latest = info;
  }
  return latest;
}

/** How much a state should catch the eye in a summary (higher wins). */
const PRIORITY: Record<SessionState["status"], number> = {
  disconnected: 0,
  connecting: 1,
  connected: 2,
  reconnecting: 3,
};

/**
 * The session that speaks for a profile in the sidebar when several tabs
 * hold one: a reconnecting one first (it needs attention), then a connected
 * one, then a connecting one, else the latest (its disconnect reason).
 */
export function summarySessionFor(
  sessions: Record<SessionId, SessionInfo>,
  profileId: ProfileId,
): SessionInfo | undefined {
  let best: SessionInfo | undefined;
  for (const info of Object.values(sessions)) {
    if (info.profileId !== profileId) continue;
    // `>=` so that among equals the latest one wins.
    if (!best || PRIORITY[info.state.status] >= PRIORITY[best.state.status]) {
      best = info;
    }
  }
  return best;
}
