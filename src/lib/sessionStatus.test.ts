import { describe, expect, it } from "vitest";

import { sessionStatus } from "./sessionStatus";

describe("sessionStatus", () => {
  it("maps each state to a dot", () => {
    expect(sessionStatus(undefined)).toMatchObject({ tone: "idle" });
    expect(sessionStatus({ status: "connecting" })).toMatchObject({
      tone: "busy",
      pulse: true,
    });
    expect(sessionStatus({ status: "connected" })).toMatchObject({
      tone: "ok",
      pulse: false,
    });
    expect(
      sessionStatus({
        status: "reconnecting",
        attempt: 2,
        maxAttempts: 5,
        nextRetryInSecs: 4,
      }),
    ).toEqual({
      tone: "warning",
      label: "Reconnecting (attempt 2 of 5)",
      pulse: true,
    });
    expect(
      sessionStatus({ status: "disconnected", reason: "connection lost" }),
    ).toEqual({ tone: "error", label: "connection lost", pulse: false });
    expect(
      sessionStatus({ status: "disconnected", reason: null }),
    ).toMatchObject({ tone: "idle", label: "Not connected" });
  });
});
