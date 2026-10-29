import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({ isMac: true, isWindows: false }));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));

import { initialPane, usePaneStore } from "../state/paneStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { TabBar } from "./TabBar";

const store = () => useTabsStore.getState();
const localTabs = () => store().local.tabs;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
    active: "local",
  });
  resetTabs();
  store().start();
  await flush();
});

describe("TabBar", () => {
  it("names each tab after its folder, with the full path as tooltip", async () => {
    render(<TabBar pane="local" />);
    await act(() =>
      usePaneStore.getState().navigate("local", "/home/alice/docs"),
    );
    act(() => void store().newTab("local"));
    await flush();
    await act(() => usePaneStore.getState().navigate("local", "/srv"));
    const [first, second] = screen.getAllByRole("tab");
    expect(first).toHaveTextContent("docs");
    expect(first).toHaveAttribute("title", "/home/alice/docs");
    expect(first).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveTextContent("srv");
    expect(second).toHaveAttribute("aria-selected", "true");
  });

  it("switches on click and opens a tab on the same folder with +", async () => {
    render(<TabBar pane="local" />);
    const first = store().local.activeTabId;
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    await flush();
    expect(localTabs()).toHaveLength(2);
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByRole("tab")[1]).toHaveTextContent("alice");
    fireEvent.click(screen.getAllByRole("tab")[0]);
    expect(store().local.activeTabId).toBe(first);
  });

  it("closes with the close button and a middle click, but keeps the last tab", async () => {
    render(<TabBar pane="local" />);
    // A lone tab cannot be closed.
    expect(
      screen.queryByRole("button", { name: /^Close/ }),
    ).not.toBeInTheDocument();
    act(() => {
      store().newTab("local");
      store().newTab("local");
    });
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: "Close alice" })[0]);
    expect(localTabs()).toHaveLength(2);
    act(() => {
      fireEvent(
        screen.getAllByRole("tab")[0],
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
    });
    expect(localTabs()).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: /^Close/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the active connection's remote tabs, and none without one", async () => {
    const { rerender } = render(<TabBar pane="remote" />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    act(() => {
      store().activate("p-1");
      store().attachSession("p-1", "s-1", "/srv/www");
    });
    await flush();
    rerender(<TabBar pane="remote" />);
    expect(screen.getByRole("tablist", { name: "Remote tabs" })).toBeVisible();
    expect(screen.getByRole("tab")).toHaveTextContent("www");
  });
});
