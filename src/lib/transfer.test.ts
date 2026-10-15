import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  enqueueTransfers: vi.fn(() => Promise.resolve("b-1")),
}));

import { enqueueTransfers } from "../ipc/commands";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useSessionStore } from "../state/sessionStore";
import { canTransfer, startTransfer, transferRequest } from "./transfer";

beforeEach(() => {
  vi.clearAllMocks();
  usePaneStore.setState({
    panes: {
      local: { ...initialPane(), target: { kind: "local" }, path: "/home" },
      remote: {
        ...initialPane(),
        target: { kind: "remote", sessionId: "s-1" },
        path: "/srv",
      },
    },
  });
  useSessionStore.setState({
    sessions: {
      "s-1": {
        sessionId: "s-1",
        profileId: "p-1",
        state: { status: "connected" },
      },
    },
  });
});

describe("transfer", () => {
  it("uploads from the local pane into the remote folder", () => {
    expect(transferRequest("local", ["/home/a.txt"])).toEqual({
      sessionId: "s-1",
      direction: "upload",
      items: [{ src: "/home/a.txt" }],
      dstDir: "/srv",
    });
  });

  it("downloads from the remote pane, into a given folder", async () => {
    await startTransfer("remote", ["/srv/a.txt"], "/home/docs");
    expect(enqueueTransfers).toHaveBeenCalledWith({
      sessionId: "s-1",
      direction: "download",
      items: [{ src: "/srv/a.txt" }],
      dstDir: "/home/docs",
    });
  });

  it("refuses without a live session or a destination folder", async () => {
    useSessionStore.setState({
      sessions: {
        "s-1": {
          sessionId: "s-1",
          profileId: "p-1",
          state: { status: "disconnected", reason: null },
        },
      },
    });
    expect(canTransfer("local")).toBe(false);
    await expect(startTransfer("local", ["/home/a.txt"])).resolves.toBe(false);
    expect(enqueueTransfers).not.toHaveBeenCalled();

    usePaneStore.setState({
      panes: { ...usePaneStore.getState().panes, remote: initialPane() },
    });
    expect(transferRequest("local", ["/home/a.txt"])).toBeNull();
  });
});
