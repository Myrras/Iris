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
    onSettingsChanged: sub("settings"),
    onTransfersUpdated: sub("transfers"),
    onTransferJobChanged: sub("job"),
    onTransferProgress: sub("progress"),
    onTransferConflict: sub("conflict"),
  };
});
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listProfiles: vi.fn(() => Promise.resolve([])),
  listTransfers: vi.fn(() =>
    Promise.resolve({
      jobs: [],
      summary: {
        totalBytes: 0,
        doneBytes: 0,
        bytesPerSec: 0,
        active: 0,
        queued: 0,
        needsDecision: 0,
        paused: 0,
      },
    }),
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({
      parallelTransfers: 4,
      reconnectAttempts: 3,
      editorOverrides: {},
    }),
  ),
}));

import { getSettings, listProfiles, listTransfers } from "../ipc/commands";
import type { HostKeyPromptEvent, TransferJob } from "../ipc/types";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { usePromptStore } from "../state/promptStore";
import { useSessionStore } from "../state/sessionStore";
import { resetTransferResync, useTransferStore } from "../state/transferStore";
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
  vi.clearAllMocks();
  resetTransferResync();
  usePromptStore.setState({ queue: [] });
  useSessionStore.setState({ sessions: {} });
  useTransferStore.setState({ jobs: {}, order: [], speeds: {} });
  useBackendSettingsStore.setState({ settings: null });
});

const job: TransferJob = {
  id: "j-1",
  batchId: "b-1",
  sessionId: "s-1",
  direction: "upload",
  src: "/home/alice/notes.txt",
  dst: "/srv/notes.txt",
  size: 100,
  bytesDone: 0,
  state: "running",
  error: null,
};

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
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(8));
  });

  it("loads the transfers and feeds transfer events into the stores", async () => {
    renderHook(() => useCoreEvents());
    await waitFor(() => expect(listTransfers).toHaveBeenCalledTimes(1));

    handlers.job({ type: "transferJobChanged", job });
    expect(useTransferStore.getState().jobs["j-1"].state).toBe("running");
    handlers.progress({
      type: "transferProgress",
      jobId: "j-1",
      batchId: "b-1",
      bytesDone: 50,
      size: 100,
      bytesPerSec: 10,
    });
    expect(useTransferStore.getState().jobs["j-1"].bytesDone).toBe(50);

    handlers.conflict({
      type: "transferConflict",
      batchId: "b-1",
      jobId: "j-1",
      src: { path: job.src, size: 100, mtime: null },
      dst: { path: job.dst, size: 40, mtime: null },
    });
    expect(usePromptStore.getState().queue[0]).toMatchObject({
      kind: "transferConflict",
    });
  });

  it("re-reads the backend settings on settings:changed once loaded", async () => {
    renderHook(() => useCoreEvents());
    handlers.settings();
    expect(getSettings).not.toHaveBeenCalled();
    useBackendSettingsStore.setState({
      settings: {
        parallelTransfers: 2,
        reconnectAttempts: 3,
        editorOverrides: {},
      },
    });
    handlers.settings();
    await waitFor(() =>
      expect(
        useBackendSettingsStore.getState().settings?.parallelTransfers,
      ).toBe(4),
    );
  });
});
