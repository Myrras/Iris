import { beforeEach, describe, expect, it } from "vitest";

import type { SessionStateChangedEvent } from "../ipc/types";
import { latestSessionFor, useSessionStore } from "./sessionStore";

function change(
  sessionId: string,
  state: SessionStateChangedEvent["state"],
  reason: string | null = null,
  profileId = "p-1",
): SessionStateChangedEvent {
  return { type: "sessionStateChanged", sessionId, profileId, state, reason };
}

beforeEach(() => {
  useSessionStore.setState({ sessions: {} });
});

describe("sessionStore", () => {
  it("tracks a session through its lifecycle", () => {
    const { apply } = useSessionStore.getState();
    apply(change("s-1", "connecting"));
    expect(useSessionStore.getState().sessions["s-1"]).toMatchObject({
      profileId: "p-1",
      state: "connecting",
    });
    apply(change("s-1", "connected"));
    expect(useSessionStore.getState().sessions["s-1"].state).toBe("connected");
    apply(change("s-1", "disconnected", "connection lost"));
    expect(useSessionStore.getState().sessions["s-1"]).toMatchObject({
      state: "disconnected",
      reason: "connection lost",
    });
  });

  it("finds the latest session of a profile", () => {
    const { apply } = useSessionStore.getState();
    apply(change("s-1", "disconnected", "auth failed"));
    apply(change("s-2", "connecting"));
    apply(change("s-3", "connected", null, "p-2"));
    const sessions = useSessionStore.getState().sessions;
    expect(latestSessionFor(sessions, "p-1")?.sessionId).toBe("s-2");
    expect(latestSessionFor(sessions, "p-2")?.sessionId).toBe("s-3");
    expect(latestSessionFor(sessions, "p-3")).toBeUndefined();
  });
});
