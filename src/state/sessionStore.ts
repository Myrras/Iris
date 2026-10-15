/**
 * Live sessions, fed only by `session:state-changed` events (`useCoreEvents`).
 * Disconnected sessions are kept so a pane can still say why its session
 * ended; they are few and tiny.
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
  state: SessionState;
  /** Why an unrequested disconnect happened (app-owned text). */
  reason: string | null;
}

interface SessionStoreState {
  /** By id, in the order the sessions first appeared. */
  sessions: Record<SessionId, SessionInfo>;
  apply: (event: SessionStateChangedEvent) => void;
}

export const useSessionStore = create<SessionStoreState>((set) => ({
  sessions: {},
  apply: ({ sessionId, profileId, state, reason }) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: { sessionId, profileId, state, reason },
      },
    })),
}));

/** The most recent session of a profile (what its sidebar dot reflects). */
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
