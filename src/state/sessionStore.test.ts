import { beforeEach, describe, expect, it } from "vitest";

import type { SessionState, SessionStateChangedEvent } from "../ipc/types";
import {
  disconnectReason,
  isConnected,
  latestSessionFor,
  summarySessionFor,
  useSessionStore,
} from "./sessionStore";

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

  it("finds the latest session of a profile", () => {
    const { apply } = useSessionStore.getState();
    apply(change("s-1", lost("auth failed")));
    apply(change("s-2", connecting));
    apply(change("s-3", connected, "p-2"));
    const sessions = useSessionStore.getState().sessions;
    expect(latestSessionFor(sessions, "p-1")?.sessionId).toBe("s-2");
    expect(latestSessionFor(sessions, "p-2")?.sessionId).toBe("s-3");
    expect(latestSessionFor(sessions, "p-3")).toBeUndefined();
  });

  it("summarizes a profile by its most pressing session", () => {
    const { apply } = useSessionStore.getState();
    apply(change("s-1", connected));
    apply(change("s-2", lost("connection refused")));
    let sessions = useSessionStore.getState().sessions;
    expect(summarySessionFor(sessions, "p-1")?.sessionId).toBe("s-1");
    apply(change("s-3", reconnecting));
    sessions = useSessionStore.getState().sessions;
    expect(summarySessionFor(sessions, "p-1")?.sessionId).toBe("s-3");
    expect(summarySessionFor(sessions, "p-9")).toBeUndefined();
  });
});
