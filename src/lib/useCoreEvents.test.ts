import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(
  () => ({}) as Record<string, (e?: unknown) => void>,
);
const unlisten = vi.hoisted(() => vi.fn());

vi.mock("../ipc/events", () => {
  const sub = (name: string) => (h: (e?: unknown) => void) => {
    handlers[name] = h;
    return Promise.resolve(unlisten);
  };
  return {
    onProfilesChanged: sub("profiles"),
    onHostKeyPrompt: sub("hostKey"),
    onSessionStateChanged: sub("state"),
  };
});
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listProfiles: vi.fn(() => Promise.resolve([])),
}));

import { listProfiles } from "../ipc/commands";
import type { HostKeyPromptEvent } from "../ipc/types";
import { usePromptStore } from "../state/promptStore";
import { useSessionStore } from "../state/sessionStore";
import { useCoreEvents } from "./useCoreEvents";

const keyEvent: HostKeyPromptEvent = {
  type: "hostKeyPrompt",
  requestId: "r-1",
  sessionId: "s-1",
  host: "alpha.example.test",
  port: 22,
  keyType: "ssh-ed25519",
  fingerprintSha256: "SHA256:AAAAexamplefingerprint",
};

beforeEach(() => {
  usePromptStore.setState({ queue: [] });
  useSessionStore.setState({ sessions: {} });
});

describe("useCoreEvents", () => {
  it("loads the profiles and reloads them on profiles:changed", async () => {
    renderHook(() => useCoreEvents());
    await waitFor(() => expect(listProfiles).toHaveBeenCalledTimes(1));
    handlers.profiles();
    await waitFor(() => expect(listProfiles).toHaveBeenCalledTimes(2));
  });

  it("queues host key prompts and tracks session states", () => {
    renderHook(() => useCoreEvents());
    handlers.hostKey(keyEvent);
    expect(usePromptStore.getState().queue[0]).toMatchObject({
      kind: "hostKey",
      event: keyEvent,
    });

    handlers.state({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state: "connecting",
      reason: null,
    });
    expect(useSessionStore.getState().sessions["s-1"].state).toBe("connecting");
  });

  it("closes a host key prompt when its session disconnects", () => {
    renderHook(() => useCoreEvents());
    handlers.hostKey(keyEvent);
    handlers.state({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state: "disconnected",
      reason: "host key prompt timed out",
    });
    expect(usePromptStore.getState().queue).toEqual([]);
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useCoreEvents());
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(3));
  });
});
