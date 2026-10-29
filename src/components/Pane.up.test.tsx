import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
  listTransfers: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("../lib/connect", () => ({
  connectProfile: vi.fn(),
  retrySession: vi.fn(),
}));
vi.mock("../lib/connections", () => ({
  requestDisconnectSession: vi.fn(),
}));

import { listDir } from "../ipc/commands";
import type { Entry } from "../ipc/types";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useSettingsStore } from "../state/settingsStore";
import { resetTabs } from "../state/tabsStore";
import { stubViewport } from "../test/viewport";
import { LocalIcon } from "./icons";
import { Pane } from "./Pane";

stubViewport();

function dir(parent: string, name: string): Entry {
  return {
    name,
    path: `${parent}/${name}`,
    kind: { type: "dir" },
    size: 0,
    mtime: null,
    mode: null,
    hidden: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTabs();
  useLayoutStore.getState().setPreviewOpen(false);
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
  useSettingsStore.getState().set("browser", { showHidden: false });
  vi.mocked(listDir).mockImplementation(async (_t, path) =>
    path === "/home"
      ? [dir("/home", "alice"), dir("/home", "bob")]
      : [dir(path, "docs")],
  );
});

describe("Up in a pane", () => {
  it("selects the folder you came from", async () => {
    render(<Pane id="local" title="Local" Icon={LocalIcon} />);
    await usePaneStore.getState().open("local", { kind: "local" }, null);
    await screen.findByText("docs");
    fireEvent.click(screen.getByLabelText("Up"));
    await screen.findByText("bob");
    await waitFor(() =>
      expect(usePaneStore.getState().panes.local.selection).toEqual([
        "/home/alice",
      ]),
    );
    expect(
      screen.getByText("alice").closest("[data-cursor='true']"),
    ).not.toBeNull();
  });
});
