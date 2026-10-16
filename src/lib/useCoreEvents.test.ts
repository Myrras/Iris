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
    onEditUploaded: sub("editUploaded"),
    onEditFailed: sub("editFailed"),
    onEditConflict: sub("editConflict"),
    onDragOutProgress: sub("dragOutProgress"),
  };
});
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listProfiles: vi.fn(() => Promise.resolve([])),
  listDir: vi.fn(() => Promise.resolve([])),
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

vi.mock("../state/toastStore", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import {
  getSettings,
  listDir,
  listProfiles,
  listTransfers,
} from "../ipc/commands";
import type { HostKeyPromptEvent, TransferJob } from "../ipc/types";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { usePromptStore } from "../state/promptStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { toastError, toastSuccess } from "../state/toastStore";
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
  folder: false,
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
      state: { status: "connecting" },
    });
    expect(useSessionStore.getState().sessions["s-1"].state).toEqual({
      status: "connecting",
    });
  });

  it("closes a host key prompt when its session disconnects", () => {
    renderHook(() => useCoreEvents());
    handlers.hostKey(keyEvent);
    handlers.state({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state: { status: "disconnected", reason: "host key prompt timed out" },
    });
    expect(usePromptStore.getState().queue).toEqual([]);
  });

  describe("reconnects", () => {
    const state = (status: unknown) =>
      handlers.state({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: status,
      });
    const reconnecting = {
      status: "reconnecting",
      attempt: 1,
      maxAttempts: 5,
      nextRetryInSecs: 1,
    };

    beforeEach(() => {
      resetTabs();
      useProfilesStore.setState({
        profiles: [
          {
            id: "p-1",
            name: "Alpha",
            host: "alpha.example.test",
            port: 22,
            user: "alice",
            auth: { kind: "agent" },
            startDir: null,
            jump: null,
          },
        ],
        loaded: true,
      });
      const tabId = useTabsStore.getState().activeTabId;
      useTabsStore
        .getState()
        .update(tabId, { sessionId: "s-1", profileId: "p-1" });
      usePaneStore.setState({
        panes: {
          local: initialPane(),
          remote: {
            ...initialPane(),
            target: { kind: "remote", sessionId: "s-1" },
            path: "/srv",
          },
        },
      });
    });

    it("toasts and re-lists the panes when the connection is back", () => {
      renderHook(() => useCoreEvents());
      state({ status: "connected" });
      state(reconnecting);
      expect(toastSuccess).not.toHaveBeenCalled();
      state({ status: "connected" });
      expect(toastSuccess).toHaveBeenCalledWith("Reconnected to Alpha");
      expect(listDir).toHaveBeenCalledWith(
        { kind: "remote", sessionId: "s-1" },
        "/srv",
      );
    });

    it("toasts why when the reconnect gave up", () => {
      renderHook(() => useCoreEvents());
      state(reconnecting);
      state({
        status: "disconnected",
        reason: "could not reconnect after 5 attempts",
      });
      expect(toastError).toHaveBeenCalledWith(
        "Could not reconnect to Alpha",
        "could not reconnect after 5 attempts",
      );
    });

    it("stays quiet for a first connect and a user disconnect", () => {
      renderHook(() => useCoreEvents());
      state({ status: "connecting" });
      state({ status: "connected" });
      state({ status: "disconnected", reason: null });
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });
  });

  it("turns restored tabs of deleted profiles into blank tabs", () => {
    resetTabs();
    const tabId = useTabsStore.getState().activeTabId;
    useTabsStore.getState().update(tabId, {
      profileId: "p-gone",
      title: "Gone",
      pendingRemotePath: "/srv",
    });
    renderHook(() => useCoreEvents());
    useProfilesStore.setState({ profiles: [], loaded: true });
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      profileId: null,
      title: "New tab",
      pendingRemotePath: null,
    });
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useCoreEvents());
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(12));
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

  describe("remote edit", () => {
    const conflict = {
      type: "editConflict",
      editId: "e-1",
      sessionId: "s-1",
      path: "/srv/notes.txt",
      remote: { size: 9, mtime: 1_700_000_100 },
      baseline: { size: 4, mtime: 1_700_000_000 },
    } as const;

    beforeEach(() => {
      usePaneStore.setState({
        panes: {
          local: initialPane(),
          remote: {
            ...initialPane(),
            target: { kind: "remote", sessionId: "s-1" },
            path: "/srv",
          },
        },
      });
    });

    it("toasts an upload and re-lists the folder showing it", () => {
      renderHook(() => useCoreEvents());
      handlers.editUploaded({
        type: "editUploaded",
        editId: "e-1",
        sessionId: "s-1",
        path: "/srv/notes (edited).txt",
      });
      expect(toastSuccess).toHaveBeenCalledWith("Uploaded notes (edited).txt");
      expect(listDir).toHaveBeenCalledWith(
        { kind: "remote", sessionId: "s-1" },
        "/srv",
      );
    });

    it("does not re-list a pane showing another folder", () => {
      renderHook(() => useCoreEvents());
      handlers.editUploaded({
        type: "editUploaded",
        editId: "e-1",
        sessionId: "s-1",
        path: "/var/www/index.html",
      });
      expect(toastSuccess).toHaveBeenCalledWith("Uploaded index.html");
      expect(listDir).not.toHaveBeenCalled();
    });

    it("toasts a failed upload with the reason", () => {
      renderHook(() => useCoreEvents());
      handlers.editFailed({
        type: "editFailed",
        editId: "e-1",
        sessionId: "s-1",
        path: "/srv/locked.txt",
        kind: "permissionDenied",
        message: "permission denied: /srv/locked.txt",
      });
      expect(toastError).toHaveBeenCalledWith(
        "Could not upload locked.txt",
        "permission denied: /srv/locked.txt. Saving again retries.",
      );
    });

    it("queues conflicts and drops them when the user disconnects", () => {
      renderHook(() => useCoreEvents());
      handlers.editConflict(conflict);
      expect(usePromptStore.getState().queue[0]).toMatchObject({
        kind: "editConflict",
        event: conflict,
      });
      // A dropped connection keeps the edit (and its question).
      handlers.state({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: { status: "disconnected", reason: "the connection was lost" },
      });
      expect(usePromptStore.getState().queue).toHaveLength(1);
      handlers.state({
        type: "sessionStateChanged",
        sessionId: "s-1",
        profileId: "p-1",
        state: { status: "disconnected", reason: null },
      });
      expect(usePromptStore.getState().queue).toEqual([]);
    });
  });
});
