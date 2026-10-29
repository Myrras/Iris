import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  connect: vi.fn(),
  reconnect: vi.fn(),
  clearSecret: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));
vi.mock("../state/toastStore", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import {
  clearSecret,
  connect,
  disconnect,
  listDir,
  reconnect,
} from "../ipc/commands";
import type { ConnectionProfile } from "../ipc/types";
import { initialPane, usePaneStore } from "../state/paneStore";
import { usePromptStore } from "../state/promptStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { toastError, toastSuccess } from "../state/toastStore";
import { useTransferStore } from "../state/transferStore";
import {
  connectProfile,
  disconnectSession,
  openConnection,
  retrySession,
} from "./connect";

const passwordProfile: ConnectionProfile = {
  id: "p-1",
  name: "Alpha",
  host: "alpha.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "password" },
  startDir: "/srv",
  jump: null,
  favorites: [],
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

const store = () => useTabsStore.getState();
const conn = (profileId: string) => store().connections[profileId];

beforeEach(() => {
  vi.clearAllMocks();
  resetTabs();
  useTransferStore.setState({ jobs: {}, order: [] });
  useProfilesStore.setState({
    profiles: [passwordProfile, keyProfile],
    loaded: true,
  });
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
    expect(conn("p-1")).toMatchObject({ sessionId: "s-1", connecting: false });
    // Connecting does not pick the connection the Remote pane shows.
    expect(store().activeProfileId).toBeNull();
    expect(remote().target).toBeNull();
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
    expect(conn("p-1").sessionId).toBe("s-1");
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

  it("returns the session a connection already has, connecting nothing", async () => {
    vi.mocked(connect).mockResolvedValue("s-1");
    await connectProfile(keyProfile);
    await expect(connectProfile(keyProfile)).resolves.toBe("s-1");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("disconnects a session whose profile was deleted while connecting", async () => {
    let release: (id: string) => void = () => undefined;
    vi.mocked(connect).mockImplementationOnce(
      () => new Promise((r) => (release = r)),
    );
    vi.mocked(disconnect).mockResolvedValue(undefined);
    const result = connectProfile(keyProfile);
    store().dropConnection("p-2");
    release("s-4");
    await expect(result).resolves.toBeNull();
    expect(disconnect).toHaveBeenCalledWith("s-4");
  });

  it("ignores a second connect of the same profile while one is running", async () => {
    let release: (id: string) => void = () => undefined;
    vi.mocked(connect).mockImplementationOnce(
      () => new Promise((r) => (release = r)),
    );
    const first = connectProfile(keyProfile);
    expect(conn("p-2").connecting).toBe(true);
    await expect(connectProfile(keyProfile)).resolves.toBeNull();
    release("s-3");
    await expect(first).resolves.toBe("s-3");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(conn("p-2").connecting).toBe(false);
  });
});

describe("openConnection", () => {
  it("connects a new connection and shows it in the Remote pane", async () => {
    vi.mocked(connect).mockResolvedValue("s-1");
    await openConnection(passwordProfile);
    expect(store().activeProfileId).toBe("p-1");
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-1" });
    await flush();
    expect(remote().path).toBe("/srv");
  });

  it("shows a connected profile again without a new connect", async () => {
    vi.mocked(connect)
      .mockResolvedValueOnce("s-1")
      .mockResolvedValueOnce("s-2");
    await openConnection(passwordProfile);
    await openConnection(keyProfile);
    expect(store().activeProfileId).toBe("p-2");
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-2" });
    await flush();

    await openConnection(passwordProfile);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(store().activeProfileId).toBe("p-1");
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-1" });
    // The other one keeps its session in the background.
    expect(conn("p-2").sessionId).toBe("s-2");
  });

  it("shows a session the core gave up on instead of connecting anew", async () => {
    vi.mocked(connect).mockResolvedValue("s-1");
    await openConnection(passwordProfile);
    await openConnection(keyProfile);
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state: { status: "disconnected", reason: "the connection was lost" },
    });
    await openConnection(passwordProfile);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-1" });
  });

  it("connects again a connection the user disconnected, in its own tabs", async () => {
    vi.mocked(connect)
      .mockResolvedValueOnce("s-1")
      .mockResolvedValueOnce("s-5");
    vi.mocked(disconnect).mockResolvedValue(undefined);
    await openConnection(passwordProfile);
    await flush();
    const tabIds = conn("p-1").remote.tabs.map((t) => t.id);
    disconnectSession("s-1");
    await flush();
    await openConnection(passwordProfile);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(conn("p-1").remote.tabs.map((t) => t.id)).toEqual(tabIds);
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-5" });
  });

  it("goes back to the connection shown before when a new one does not come up", async () => {
    vi.mocked(connect)
      .mockResolvedValueOnce("s-1")
      .mockRejectedValueOnce({ kind: "passwordRequired", message: "needed" });
    await openConnection(keyProfile);
    const result = openConnection(passwordProfile);
    await flush();
    // Shown at once, waiting for the password.
    expect(store().activeProfileId).toBe("p-1");
    const prompt = head();
    if (prompt.kind !== "secret") throw new Error("unreachable");
    prompt.onCancel();
    await result;
    expect(conn("p-1")).toBeUndefined();
    expect(store().activeProfileId).toBe("p-2");
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-1" });
  });

  it("hands the session to its connection after a switch, in the background", async () => {
    let release: (id: string) => void = () => undefined;
    vi.mocked(connect)
      .mockResolvedValueOnce("s-1")
      .mockImplementationOnce(() => new Promise((r) => (release = r)));
    await openConnection(passwordProfile);
    const result = openConnection(keyProfile);
    expect(conn("p-2").connecting).toBe(true);
    await openConnection(passwordProfile);
    release("s-3");
    await result;
    expect(conn("p-2")).toMatchObject({ sessionId: "s-3", connecting: false });
    // The connection on screen is untouched.
    expect(store().activeProfileId).toBe("p-1");
    expect(remote().target).toEqual({ kind: "remote", sessionId: "s-1" });
  });
});

describe("retrySession", () => {
  function dropped(sessionId: string, profileId = "p-1") {
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId,
      profileId,
      state: { status: "disconnected", reason: "the connection was lost" },
    });
  }

  it("reconnects the same session and re-lists its pane", async () => {
    vi.mocked(connect).mockResolvedValue("s-1");
    await openConnection(keyProfile);
    await flush();
    dropped("s-1", "p-2");
    vi.mocked(reconnect).mockResolvedValue(undefined);
    const lists = vi.mocked(listDir).mock.calls.length;
    await expect(retrySession("s-1")).resolves.toBe(true);
    expect(reconnect).toHaveBeenCalledWith("s-1");
    expect(toastSuccess).toHaveBeenCalledWith("Reconnected to Beta");
    await flush();
    expect(vi.mocked(listDir).mock.calls.length).toBeGreaterThan(lists);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("asks for the password the reconnect needs", async () => {
    dropped("s-1");
    vi.mocked(reconnect)
      .mockRejectedValueOnce({
        kind: "passwordRequired",
        message: "a password is required",
      })
      .mockResolvedValueOnce(undefined);
    const result = retrySession("s-1");
    await flush();
    const prompt = head();
    expect(prompt).toMatchObject({ kind: "secret", secret: "password" });
    if (prompt.kind !== "secret") throw new Error("unreachable");
    await prompt.attempt("example-password", true);
    await expect(result).resolves.toBe(true);
    expect(reconnect).toHaveBeenLastCalledWith("s-1", {
      password: "example-password",
      remember: true,
    });
  });

  it("reports a reconnect that fails", async () => {
    dropped("s-1");
    vi.mocked(reconnect).mockRejectedValueOnce({
      kind: "connectFailed",
      message: "could not connect: connection refused",
    });
    await expect(retrySession("s-1")).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledWith(
      "Could not reconnect to Alpha",
      "could not connect: connection refused",
    );
  });
});

describe("disconnectSession", () => {
  it("disconnects and keeps the connection's tabs, ready to connect again", async () => {
    vi.mocked(connect).mockResolvedValue("s-1");
    vi.mocked(disconnect).mockResolvedValue(undefined);
    await openConnection(passwordProfile);
    await flush();
    disconnectSession("s-1");
    await flush();
    expect(disconnect).toHaveBeenCalledWith("s-1");
    expect(remote().target).toBeNull();
    expect(store().activeProfileId).toBe("p-1");
    expect(conn("p-1").sessionId).toBeNull();
    expect(conn("p-1").remote.tabs[0].pendingPath).toBe("/srv");
  });

  it("asks first when the session still has transfers", async () => {
    vi.mocked(connect).mockResolvedValue("s-1");
    await connectProfile(passwordProfile);
    useTransferStore.setState({
      jobs: {
        "j-1": {
          id: "j-1",
          batchId: "b-1",
          sessionId: "s-1",
          direction: "upload",
          src: "/home/alice/a.txt",
          dst: "/srv/a.txt",
          size: 10,
          bytesDone: 2,
          state: "paused",
          error: null,
          folder: false,
          startedAt: null,
          finishedAt: null,
        },
      },
      order: ["j-1"],
    });
    disconnectSession("s-1");
    expect(disconnect).not.toHaveBeenCalled();
    expect(store().pending).toEqual({ profileId: "p-1" });
  });
});
