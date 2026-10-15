import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  connect: vi.fn(),
  clearSecret: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));
vi.mock("../state/toastStore", () => ({ toastError: vi.fn() }));

import { clearSecret, connect, disconnect } from "../ipc/commands";
import type { ConnectionProfile } from "../ipc/types";
import { initialPane, usePaneStore } from "../state/paneStore";
import { usePromptStore } from "../state/promptStore";
import { useSessionStore } from "../state/sessionStore";
import { toastError } from "../state/toastStore";
import { connectProfile, disconnectSession } from "./connect";

const passwordProfile: ConnectionProfile = {
  id: "p-1",
  name: "Alpha",
  host: "alpha.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "password" },
  startDir: "/srv",
  jump: null,
};
const keyProfile: ConnectionProfile = {
  ...passwordProfile,
  id: "p-2",
  name: "Beta",
  auth: { kind: "keyFile", path: "/home/alice/.ssh/id_example" },
  startDir: null,
};

const head = () => usePromptStore.getState().queue[0];
const remote = () => usePaneStore.getState().panes.remote;

beforeEach(() => {
  usePromptStore.setState({ queue: [] });
  useSessionStore.setState({ sessions: {} });
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("connectProfile", () => {
  const needsPassword = {
    kind: "passwordRequired",
    message: "a password is required",
  };

  it("connects with what the backend remembers, asking nothing", async () => {
    vi.mocked(connect).mockResolvedValue("s-1");
    await expect(connectProfile(passwordProfile)).resolves.toBe("s-1");
    expect(connect).toHaveBeenCalledWith("p-1");
    expect(head()).toBeUndefined();
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-1" });
    await flush();
    expect(remote().path).toBe("/srv");
  });

  it("asks for a missing password and passes remember along", async () => {
    vi.mocked(connect)
      .mockRejectedValueOnce(needsPassword)
      .mockResolvedValueOnce("s-1");
    const result = connectProfile(passwordProfile);
    await flush();

    const prompt = head();
    expect(prompt).toMatchObject({
      kind: "secret",
      secret: "password",
      notice: undefined,
      rememberByDefault: false,
    });
    if (prompt.kind !== "secret") throw new Error("unreachable");
    await prompt.attempt("example-password", true);

    await expect(result).resolves.toBe("s-1");
    expect(connect).toHaveBeenLastCalledWith("p-1", {
      password: "example-password",
      remember: true,
    });
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-1" });
    expect(clearSecret).not.toHaveBeenCalled();
  });

  it("keeps the prompt open on a wrong password", async () => {
    vi.mocked(connect).mockRejectedValueOnce(needsPassword).mockRejectedValue({
      kind: "authFailed",
      message: "authentication failed",
    });
    void connectProfile(passwordProfile);
    await flush();
    const prompt = head();
    if (prompt.kind !== "secret") throw new Error("unreachable");
    await expect(prompt.attempt("wrong", false)).rejects.toMatchObject({
      kind: "authFailed",
    });
    expect(toastError).not.toHaveBeenCalled();
    prompt.onCancel(); // ends the connect so the next test starts clean
  });

  it("re-asks when the saved password is refused, replacing it by default", async () => {
    vi.mocked(connect)
      .mockRejectedValueOnce({
        kind: "authFailed",
        message: "authentication failed",
      })
      .mockResolvedValueOnce("s-1");
    const result = connectProfile(passwordProfile);
    await flush();
    const prompt = head();
    expect(prompt).toMatchObject({
      secret: "password",
      rememberByDefault: true,
    });
    if (prompt.kind !== "secret") throw new Error("unreachable");
    expect(prompt.notice).toMatch(/saved password was not accepted/);
    await prompt.attempt("new-password", true);
    await expect(result).resolves.toBe("s-1");
    expect(clearSecret).not.toHaveBeenCalled();
  });

  it("forgets a refused saved secret the user chose not to keep", async () => {
    vi.mocked(connect)
      .mockRejectedValueOnce({
        kind: "keyFile",
        message: "key file: wrong passphrase",
      })
      .mockResolvedValueOnce("s-2");
    const result = connectProfile(keyProfile);
    await flush();
    const prompt = head();
    expect(prompt).toMatchObject({
      secret: "passphrase",
      rememberByDefault: true,
    });
    if (prompt.kind !== "secret") throw new Error("unreachable");
    await prompt.attempt("example-passphrase", false);
    await expect(result).resolves.toBe("s-2");
    expect(clearSecret).toHaveBeenCalledWith("p-2", "passphrase");
  });

  it("resolves null when the prompt is cancelled", async () => {
    vi.mocked(connect).mockRejectedValueOnce(needsPassword);
    const result = connectProfile(passwordProfile);
    await flush();
    const prompt = head();
    if (prompt.kind !== "secret") throw new Error("unreachable");
    prompt.onCancel();
    await expect(result).resolves.toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("connects a key file directly, prompting only for a passphrase", async () => {
    vi.mocked(connect)
      .mockRejectedValueOnce({
        kind: "passphraseRequired",
        message: "passphrase required",
      })
      .mockResolvedValueOnce("s-2");
    const result = connectProfile(keyProfile);
    await flush();

    expect(connect).toHaveBeenCalledWith("p-2");
    const prompt = head();
    expect(prompt).toMatchObject({ kind: "secret", secret: "passphrase" });
    if (prompt.kind !== "secret") throw new Error("unreachable");
    await prompt.attempt("example-passphrase", false);
    await expect(result).resolves.toBe("s-2");
    expect(connect).toHaveBeenLastCalledWith("p-2", {
      passphrase: "example-passphrase",
      remember: false,
    });
  });

  it("reports agent and jump host failures without prompting", async () => {
    const agentProfile: ConnectionProfile = {
      ...passwordProfile,
      id: "p-3",
      name: "Gamma",
      auth: { kind: "agent" },
    };
    vi.mocked(connect).mockRejectedValueOnce({
      kind: "authFailed",
      message: "authentication failed",
    });
    await expect(connectProfile(agentProfile)).resolves.toBeNull();
    vi.mocked(connect).mockRejectedValueOnce({
      kind: "jumpHost",
      message: "jump host: bastion: authentication failed",
    });
    await expect(connectProfile(agentProfile)).resolves.toBeNull();
    expect(head()).toBeUndefined();
    expect(toastError).toHaveBeenLastCalledWith(
      "Could not connect to Gamma",
      "jump host: bastion: authentication failed",
    );
  });

  it("shows a blocking warning when the host key changed", async () => {
    vi.mocked(connect).mockRejectedValue({
      kind: "hostKeyChanged",
      message: "host key changed",
    });
    await expect(connectProfile(keyProfile)).resolves.toBeNull();
    expect(head()).toMatchObject({
      kind: "hostKeyChanged",
      profileName: "Beta",
      message: "host key changed",
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("closes a secret prompt on a non-retryable error and reports it", async () => {
    vi.mocked(connect).mockRejectedValueOnce(needsPassword).mockRejectedValue({
      kind: "connectFailed",
      message: "connection refused",
    });
    const result = connectProfile(passwordProfile);
    await flush();
    const prompt = head();
    if (prompt.kind !== "secret") throw new Error("unreachable");
    await expect(prompt.attempt("pw", false)).resolves.toBeUndefined();
    await expect(result).resolves.toBeNull();
    expect(toastError).toHaveBeenCalledWith(
      "Could not connect to Alpha",
      "connection refused",
    );
  });

  it("stays quiet when the user rejected the host key", async () => {
    vi.mocked(connect).mockRejectedValue({
      kind: "hostKeyRejected",
      message: "rejected",
    });
    await expect(connectProfile(keyProfile)).resolves.toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an already connected session instead of reconnecting", async () => {
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-9",
      profileId: "p-2",
      state: "connected",
      reason: null,
    });
    await expect(connectProfile(keyProfile)).resolves.toBe("s-9");
    expect(connect).not.toHaveBeenCalled();
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-9" });
  });

  it("ignores a second connect while one is running", async () => {
    let release: (id: string) => void = () => undefined;
    vi.mocked(connect).mockImplementationOnce(
      () => new Promise((r) => (release = r)),
    );
    const first = connectProfile(keyProfile);
    await expect(connectProfile(keyProfile)).resolves.toBeNull();
    release("s-3");
    await expect(first).resolves.toBe("s-3");
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe("disconnectSession", () => {
  it("disconnects and returns the remote pane to its welcome state", async () => {
    await usePaneStore
      .getState()
      .open("remote", { kind: "remote", sessionId: "s-1" }, null);
    vi.mocked(disconnect).mockResolvedValue(undefined);
    await disconnectSession("s-1");
    expect(disconnect).toHaveBeenCalledWith("s-1");
    expect(remote().target).toBeNull();
  });

  it("leaves the remote pane alone for another session", async () => {
    await usePaneStore
      .getState()
      .open("remote", { kind: "remote", sessionId: "s-1" }, null);
    vi.mocked(disconnect).mockResolvedValue(undefined);
    await disconnectSession("s-2");
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-1" });
  });
});
