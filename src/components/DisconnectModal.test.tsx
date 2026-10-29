import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  disconnect: vi.fn(() => Promise.resolve()),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));

import { disconnect } from "../ipc/commands";
import type { TransferJob } from "../ipc/types";
import { requestDisconnect } from "../lib/connections";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { useTransferStore } from "../state/transferStore";
import { DisconnectModal } from "./DisconnectModal";

function job(extra: Partial<TransferJob> = {}): TransferJob {
  return {
    id: "j-1",
    batchId: "b-1",
    sessionId: "s-1",
    direction: "download",
    src: "/srv/backup.tar",
    dst: "/home/alice/backup.tar",
    size: 2048,
    bytesDone: 512,
    state: "running",
    error: null,
    folder: false,
    startedAt: null,
    finishedAt: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
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
        favorites: [],
      },
    ],
    loaded: true,
  });
  useTransferStore.setState({
    jobs: { "j-1": job(), "j-2": job({ id: "j-2", state: "paused" }) },
    order: ["j-1", "j-2"],
  });
  useTabsStore.getState().activate("p-1");
  useTabsStore.getState().attachSession("p-1", "s-1", "/srv");
});

describe("DisconnectModal", () => {
  it("asks before disconnecting a connection that still has transfers", async () => {
    render(<DisconnectModal />);
    act(() => requestDisconnect("p-1"));
    const dialog = screen.getByRole("dialog", { name: "Disconnect?" });
    expect(dialog).toHaveTextContent("2 transfers of Alpha will be cancelled");
    expect(dialog).toHaveTextContent("1 copying");
    expect(dialog).toHaveTextContent("1 paused");
    expect(disconnect).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(useTabsStore.getState().pending).toBeNull();
    expect(useTabsStore.getState().connections["p-1"].sessionId).toBe("s-1");

    act(() => requestDisconnect("p-1"));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Disconnect?" })).getByRole(
          "button",
          { name: "Disconnect" },
        ),
      );
    });
    expect(disconnect).toHaveBeenCalledWith("s-1");
    // The connection and its tabs stay, ready to Reconnect.
    expect(useTabsStore.getState().connections["p-1"]).toMatchObject({
      sessionId: null,
    });
    expect(useTabsStore.getState().activeProfileId).toBe("p-1");
  });
});
