import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ mac: true }));
vi.mock("../lib/platform", () => ({
  get isMac() {
    return platform.mac;
  },
  isWindows: false,
}));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  disconnect: vi.fn(() => Promise.resolve()),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));

import { disconnect } from "../ipc/commands";
import type { TransferJob } from "../ipc/types";
import { useTabShortcuts } from "../lib/useTabShortcuts";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { useTransferStore } from "../state/transferStore";
import { TabBar } from "./TabBar";
import { TabCloseModal } from "./TabCloseModal";

const tabs = () => useTabsStore.getState().tabs;
const activeId = () => useTabsStore.getState().activeTabId;

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
  platform.mac = true;
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  resetTabs();
  useSessionStore.setState({ sessions: {} });
  useTransferStore.setState({ jobs: {}, order: [] });
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
});

/** Two tabs: Alpha (connected, `s-1`) on screen, and a blank one. */
function twoTabs() {
  const alpha = activeId();
  useTabsStore
    .getState()
    .update(alpha, { profileId: "p-1", title: "Old name", sessionId: "s-1" });
  useSessionStore.getState().apply({
    type: "sessionStateChanged",
    sessionId: "s-1",
    profileId: "p-1",
    state: { status: "connected" },
  });
  const blank = useTabsStore.getState().newTab();
  useTabsStore.getState().switchTo(alpha);
  return { alpha, blank };
}

describe("TabBar", () => {
  it("shows each tab with its session's dot, named after its profile", () => {
    twoTabs();
    render(<TabBar />);
    const [first, second] = screen.getAllByRole("tab");
    expect(first).toHaveTextContent("Alpha");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(
      within(first).getByRole("img", { name: "Connected" }),
    ).toHaveAttribute("data-tone", "ok");
    expect(second).toHaveTextContent("New tab");
    expect(
      within(second).getByRole("img", { name: "Not connected" }),
    ).toBeInTheDocument();
  });

  it("pulses a warning while the tab's session reconnects", () => {
    twoTabs();
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state: {
        status: "reconnecting",
        attempt: 1,
        maxAttempts: 5,
        nextRetryInSecs: 1,
      },
    });
    render(<TabBar />);
    const dot = within(screen.getAllByRole("tab")[0]).getByRole("img");
    expect(dot).toHaveAttribute("data-tone", "warning");
    expect(dot).toHaveAttribute("data-pulse", "true");
  });

  it("switches on click and opens a tab with +", () => {
    const { blank } = twoTabs();
    render(<TabBar />);
    fireEvent.click(screen.getAllByRole("tab")[1]);
    expect(activeId()).toBe(blank);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(tabs()).toHaveLength(3);
    expect(screen.getAllByRole("tab")[2]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("closes with the close button and with a middle click", async () => {
    const { blank } = twoTabs();
    render(<TabBar />);
    fireEvent.click(screen.getByRole("button", { name: "Close New tab" }));
    expect(tabs().map((t) => t.id)).not.toContain(blank);
    // Closing a connected tab disconnects its session.
    await act(async () => {
      fireEvent(
        screen.getAllByRole("tab")[0],
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
    });
    expect(disconnect).toHaveBeenCalledWith("s-1");
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0].sessionId).toBeNull();
  });

  it("asks before closing a tab whose session still has transfers", async () => {
    const { alpha } = twoTabs();
    useTransferStore.setState({
      jobs: { "j-1": job(), "j-2": job({ id: "j-2", state: "paused" }) },
      order: ["j-1", "j-2"],
    });
    render(
      <>
        <TabBar />
        <TabCloseModal />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Alpha" }));
    const dialog = screen.getByRole("dialog", { name: "Close tab?" });
    expect(dialog).toHaveTextContent("2 transfers of Alpha will be cancelled");
    expect(dialog).toHaveTextContent("1 copying");
    expect(dialog).toHaveTextContent("1 paused");
    expect(disconnect).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(tabs().map((t) => t.id)).toContain(alpha);

    fireEvent.click(screen.getByRole("button", { name: "Close Alpha" }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Close tab?" })).getByRole(
          "button",
          { name: "Close tab" },
        ),
      );
    });
    expect(disconnect).toHaveBeenCalledWith("s-1");
    expect(tabs().map((t) => t.id)).not.toContain(alpha);
  });
});

describe("tab shortcuts", () => {
  function press(key: string, extra: KeyboardEventInit = {}) {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          metaKey: platform.mac,
          ctrlKey: !platform.mac,
          bubbles: true,
          ...extra,
        }),
      );
    });
  }

  it("opens, switches and closes tabs with Cmd on macOS", () => {
    renderHook(() => useTabShortcuts());
    const first = activeId();
    press("t");
    press("t");
    expect(tabs()).toHaveLength(3);
    press("1");
    expect(activeId()).toBe(first);
    press("9");
    expect(activeId()).toBe(tabs()[2].id);
    press("2");
    expect(activeId()).toBe(tabs()[1].id);
    press("]", { shiftKey: true, code: "BracketRight" });
    expect(activeId()).toBe(tabs()[2].id);
    press("[", { shiftKey: true, code: "BracketLeft" });
    expect(activeId()).toBe(tabs()[1].id);
    press("w");
    expect(tabs()).toHaveLength(2);
  });

  it("uses Ctrl elsewhere and leaves fields and plain keys alone", () => {
    platform.mac = false;
    renderHook(() => useTabShortcuts());
    press("t");
    expect(tabs()).toHaveLength(2);
    // Cmd is not the modifier off macOS.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "t", metaKey: true }),
      );
    });
    expect(tabs()).toHaveLength(2);

    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "t",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    expect(tabs()).toHaveLength(2);
    input.remove();
  });
});
