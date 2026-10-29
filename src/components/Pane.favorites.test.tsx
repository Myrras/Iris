/** The favorite star in the path bar and the folder rows' menu items. */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  localFavorites: [] as { path: string; label: string | null }[],
  profiles: [] as unknown[],
}));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
  listTransfers: vi.fn(() => new Promise(() => undefined)),
  getSettings: vi.fn(() =>
    Promise.resolve({
      parallelTransfers: 4,
      reconnectAttempts: 5,
      editorOverrides: {},
      syncExcludes: [],
      localFavorites: backend.localFavorites,
    }),
  ),
  setLocalFavorites: vi.fn((favorites: typeof backend.localFavorites) => {
    backend.localFavorites = favorites;
    return Promise.resolve(favorites);
  }),
  listProfiles: vi.fn(() => Promise.resolve(backend.profiles)),
  setProfileFavorites: vi.fn(
    (profileId: string, favorites: typeof backend.localFavorites) => {
      backend.profiles = (backend.profiles as ConnectionProfile[]).map((p) =>
        p.id === profileId ? { ...p, favorites } : p,
      );
      return Promise.resolve(favorites);
    },
  ),
}));
vi.mock("../lib/connect", () => ({
  connectProfile: vi.fn(),
  openConnection: vi.fn(),
  retrySession: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../lib/connections", () => ({
  requestDisconnectSession: vi.fn(),
}));

import {
  listDir,
  setLocalFavorites,
  setProfileFavorites,
} from "../ipc/commands";
import type { ConnectionProfile, Entry, SessionState } from "../ipc/types";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { stubViewport } from "../test/viewport";
import { LocalIcon, ServerIcon } from "./icons";
import { Pane } from "./Pane";

stubViewport();

const prod: ConnectionProfile = {
  id: "p-1",
  name: "prod",
  host: "prod.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "agent" },
  startDir: "/srv",
  jump: null,
  favorites: [],
};

const dir = (path: string): Entry => ({
  name: path.split("/").pop() ?? path,
  path,
  kind: { type: "dir" },
  size: 0,
  mtime: null,
  mode: null,
  hidden: false,
});
const file = (path: string): Entry => ({
  ...dir(path),
  kind: { type: "file" },
});

const LISTINGS: Record<string, Entry[]> = {
  "/home/alice": [dir("/home/alice/docs"), file("/home/alice/notes.txt")],
  "/srv": [dir("/srv/www"), file("/srv/readme.md")],
};

function sessionState(state: SessionState) {
  useSessionStore.getState().apply({
    type: "sessionStateChanged",
    sessionId: "s-1",
    profileId: "p-1",
    state,
  });
}

const localPane = () => screen.getByRole("region", { name: "Local files" });
const remotePane = () => screen.getByRole("region", { name: "Remote files" });
const star = (pane: HTMLElement) =>
  within(pane).getByRole("button", {
    name: /^(Add to|Remove from) Favorites$/,
  });
const menuLabels = () =>
  screen.getAllByRole("menuitem").map((item) => item.firstChild?.textContent);

/** Both panes: Local at home, Remote on prod's /srv over s-1. */
async function renderBoth() {
  render(
    <>
      <Pane id="local" title="Local" Icon={LocalIcon} />
      <Pane id="remote" title="Remote" Icon={ServerIcon} />
    </>,
  );
  sessionState({ status: "connected" });
  await act(async () => {
    useTabsStore.getState().start();
    useTabsStore.getState().activate("p-1");
    useTabsStore.getState().attachSession("p-1", "s-1", "/srv");
  });
  await screen.findByText("notes.txt");
  await within(remotePane()).findByText("readme.md");
}

beforeEach(() => {
  vi.clearAllMocks();
  backend.localFavorites = [];
  backend.profiles = [prod];
  resetTabs();
  useLayoutStore.getState().setPreviewOpen(false);
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
    active: "local",
  });
  useSessionStore.setState({ sessions: {} });
  useBackendSettingsStore.setState({ settings: null });
  useProfilesStore.setState({ profiles: [prod], loaded: true });
  vi.mocked(listDir).mockImplementation(
    async (_t, path) => LISTINGS[path] ?? [],
  );
});

describe("the favorite star", () => {
  it("adds and removes the Local pane's folder", async () => {
    await renderBoth();
    const button = star(localPane());
    expect(button).toHaveAccessibleName("Add to Favorites");
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    await waitFor(() =>
      expect(star(localPane())).toHaveAttribute("aria-pressed", "true"),
    );
    // The settings were read first, so nothing stored gets lost.
    expect(setLocalFavorites).toHaveBeenCalledWith([
      { path: "/home/alice", label: null },
    ]);
    expect(star(localPane())).toHaveAccessibleName("Remove from Favorites");

    fireEvent.click(star(localPane()));
    await waitFor(() =>
      expect(star(localPane())).toHaveAttribute("aria-pressed", "false"),
    );
    expect(setLocalFavorites).toHaveBeenLastCalledWith([]);
    expect(setProfileFavorites).not.toHaveBeenCalled();
  });

  it("adds the Remote pane's folder to the connection's favorites", async () => {
    await renderBoth();
    fireEvent.click(star(remotePane()));
    await waitFor(() =>
      expect(star(remotePane())).toHaveAttribute("aria-pressed", "true"),
    );
    expect(setProfileFavorites).toHaveBeenCalledWith("p-1", [
      { path: "/srv", label: null },
    ]);
    expect(setLocalFavorites).not.toHaveBeenCalled();
    // Local's star is about Local's folders only.
    expect(star(localPane())).toHaveAttribute("aria-pressed", "false");
  });

  it("is disabled in the Remote pane without a connected session", async () => {
    await renderBoth();
    expect(star(remotePane())).toBeEnabled();
    act(() =>
      sessionState({
        status: "reconnecting",
        attempt: 1,
        maxAttempts: 5,
        nextRetryInSecs: 1,
      }),
    );
    expect(star(remotePane())).toBeDisabled();
    fireEvent.click(star(remotePane()));
    expect(setProfileFavorites).not.toHaveBeenCalled();
    // Local's star does not depend on any session.
    expect(star(localPane())).toBeEnabled();
  });
});

describe("the folder row menu", () => {
  it("adds and removes a Local folder, and offers nothing for files", async () => {
    await renderBoth();
    fireEvent.contextMenu(within(localPane()).getByText("docs"));
    expect(menuLabels()).toContain("Add to Favorites");
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to Favorites" }));
    await waitFor(() =>
      expect(setLocalFavorites).toHaveBeenCalledWith([
        { path: "/home/alice/docs", label: null },
      ]),
    );
    await waitFor(() =>
      expect(
        useBackendSettingsStore.getState().settings?.localFavorites,
      ).toHaveLength(1),
    );

    fireEvent.contextMenu(within(localPane()).getByText("docs"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Remove from Favorites" }),
    );
    await waitFor(() => expect(setLocalFavorites).toHaveBeenLastCalledWith([]));

    fireEvent.contextMenu(within(localPane()).getByText("notes.txt"));
    expect(menuLabels()).not.toContain("Add to Favorites");
  });

  it("adds a Remote folder to the connection's favorites", async () => {
    await renderBoth();
    fireEvent.contextMenu(within(remotePane()).getByText("www"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to Favorites" }));
    await waitFor(() =>
      expect(setProfileFavorites).toHaveBeenCalledWith("p-1", [
        { path: "/srv/www", label: null },
      ]),
    );
    await waitFor(() =>
      expect(useProfilesStore.getState().profiles[0].favorites).toEqual([
        { path: "/srv/www", label: null },
      ]),
    );
    fireEvent.contextMenu(within(remotePane()).getByText("www"));
    expect(menuLabels()).toContain("Remove from Favorites");
  });
});
