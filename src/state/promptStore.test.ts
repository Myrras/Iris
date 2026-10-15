import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionProfile, HostKeyPromptEvent } from "../ipc/types";
import { usePromptStore } from "./promptStore";

const profile: ConnectionProfile = {
  id: "p-1",
  name: "Alpha",
  host: "alpha.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "password" },
  startDir: null,
  jump: null,
};

function hostKey(
  sessionId: string,
  requestId = `r-${sessionId}`,
): HostKeyPromptEvent {
  return {
    type: "hostKeyPrompt",
    requestId,
    sessionId,
    host: "alpha.example.test",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprintSha256: "SHA256:AAAAexamplefingerprint",
  };
}

function secret() {
  return {
    kind: "secret" as const,
    secret: "password" as const,
    profile,
    attempt: vi.fn(() => Promise.resolve()),
    onCancel: vi.fn(),
  };
}

const head = () => usePromptStore.getState().queue[0];

beforeEach(() => {
  usePromptStore.setState({ queue: [] });
});

describe("promptStore", () => {
  it("queues prompts and shows them one at a time", () => {
    const { push, resolve } = usePromptStore.getState();
    const a = push(secret());
    const b = push({
      kind: "hostKeyChanged",
      profileName: "Alpha",
      message: "host key changed",
    });
    expect(head().id).toBe(a);
    resolve(a);
    expect(head().id).toBe(b);
    resolve(b);
    expect(head()).toBeUndefined();
  });

  it("puts a host key prompt in front: it blocks a running connect", () => {
    const { push } = usePromptStore.getState();
    push(secret());
    const key = push({ kind: "hostKey", event: hostKey("s-1") });
    expect(head().id).toBe(key);
  });

  it("keeps host key prompts in arrival order among themselves", () => {
    const { push } = usePromptStore.getState();
    const first = push({ kind: "hostKey", event: hostKey("s-1") });
    push({ kind: "hostKey", event: hostKey("s-2") });
    expect(head().id).toBe(first);
  });

  it("drops a session's host key prompt when it disconnects", () => {
    const { push, dropSession } = usePromptStore.getState();
    push({ kind: "hostKey", event: hostKey("s-1") });
    const other = push({ kind: "hostKey", event: hostKey("s-2") });
    dropSession("s-1");
    expect(usePromptStore.getState().queue.map((p) => p.id)).toEqual([other]);
  });

  it("ignores resolving an unknown prompt", () => {
    const { push, resolve } = usePromptStore.getState();
    const a = push(secret());
    resolve(9999);
    expect(head().id).toBe(a);
  });
});
