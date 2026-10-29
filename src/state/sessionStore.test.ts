import { beforeEach, describe, expect, it } from "vitest";

import type { SessionState, SessionStateChangedEvent } from "../ipc/types";
import { disconnectReason, isConnected, useSessionStore } from "./sessionStore";

function change(
  sessionId: string,
  state: SessionState,
  profileId = "p-1",
): SessionStateChangedEvent {
  return { type: "sessionStateChanged", sessionId, profileId, state };
}

const connecting: SessionState = { status: "connecting" };
const connected: SessionState = { status: "connected" };
const lost = (reason: string | null): SessionState => ({
  status: "disconnected",
  reason,
});
const reconnecting: SessionState = {
  status: "reconnecting",
  attempt: 1,
  maxAttempts: 5,
  nextRetryInSecs: 1,
};

beforeEach(() => {
  useSessionStore.setState({ sessions: {} });
});

describe("sessionStore", () => {
  it("tracks a session through its lifecycle and returns the previous state", () => {
    const { apply } = useSessionStore.getState();
    expect(apply(change("s-1", connecting))).toBeUndefined();
    expect(useSessionStore.getState().sessions["s-1"]).toMatchObject({
      profileId: "p-1",
      state: connecting,
    });
    expect(apply(change("s-1", connected))).toEqual(connecting);
    expect(isConnected(useSessionStore.getState().sessions["s-1"])).toBe(true);
    expect(apply(change("s-1", reconnecting))).toEqual(connected);
    expect(isConnected(useSessionStore.getState().sessions["s-1"])).toBe(false);
    apply(change("s-1", lost("connection lost")));
    expect(disconnectReason(useSessionStore.getState().sessions["s-1"])).toBe(
      "connection lost",
    );
  });
});
