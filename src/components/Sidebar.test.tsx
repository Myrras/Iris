import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  deleteProfile: vi.fn(() => Promise.resolve()),
  listProfiles: vi.fn(() => Promise.resolve([])),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
  getSettings: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("../lib/connect", () => ({
  openConnection: vi.fn(),
  disconnectSession: vi.fn(),
}));

import { deleteProfile } from "../ipc/commands";
import type { ConnectionProfile, SessionState } from "../ipc/types";
import { disconnectSession, openConnection } from "../lib/connect";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { Sidebar } from "./Sidebar";

const alpha: ConnectionProfile = {
  id: "p-1",
  name: "Alpha",
  host: "alpha.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "password" },
  startDir: null,
  jump: null,
  favorites: [],
};
const beta: ConnectionProfile = { ...alpha, id: "p-2", name: "Beta" };

function withProfiles(profiles: ConnectionProfile[]) {
  useProfilesStore.setState({ profiles, loaded: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTabs();
  useProfilesStore.setState({ profiles: [], loaded: true });
  useSessionStore.setState({ sessions: {} });
  useConnectionFormStore.setState({ open: false, editing: null });
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
  });
});

describe("Sidebar", () => {
  it("shows the empty Connections section with a single call to action", () => {
    render(<Sidebar />);
    expect(screen.getByText("No connections yet.")).toBeInTheDocument();
    // Only the footer button invites adding one (no second link inside).
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual([
      "Local",
      "Home",
      "Connections",
      "New connection…",
    ]);
  });

  it("collapses and expands the Connections section", () => {
    render(<Sidebar />);
    const toggle = screen.getByRole("button", { name: "Connections" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("opens the new-connection form from the footer", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "New connection…" }));
    expect(useConnectionFormStore.getState()).toMatchObject({
      open: true,
      editing: null,
    });
  });

  /** `profileId`'s connection holds `sessionId`, in `state`. */
  function session(
    profileId: string,
    sessionId: string,
    state: SessionState = { status: "connected" },
  ) {
    useTabsStore.getState().ensureConnection(profileId);
    useTabsStore.getState().attachSession(profileId, sessionId, null);
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId,
      profileId,
      state,
    });
  }

  it("lists saved connections with the state of their session", () => {
    withProfiles([alpha, beta]);
    session("p-1", "s-1");
    session("p-2", "s-2", {
      status: "disconnected",
      reason: "connection refused",
    });
    render(<Sidebar />);
    const list = screen.getByRole("list", { name: "Saved connections" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("Alpha");
    expect(
      within(first).getByRole("img", { name: "Connected" }),
    ).toBeInTheDocument();
    expect(
      within(second).getByRole("img", { name: "connection refused" }),
    ).toBeInTheDocument();
  });

  it("shows a connection without a session as not connected", () => {
    withProfiles([alpha]);
    // A session that belongs to no connection (gone, or never shown).
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-9",
      profileId: "p-1",
      state: { status: "connected" },
    });
    render(<Sidebar />);
    expect(
      screen.getByRole("img", { name: "Not connected" }),
    ).toBeInTheDocument();
  });

  it("opens the connection on click", () => {
    withProfiles([alpha]);
    render(<Sidebar />);
    fireEvent.click(screen.getByText("Alpha"));
    expect(openConnection).toHaveBeenCalledWith(alpha);
  });

  it("marks the active connection and disconnects each one by its own session", () => {
    withProfiles([alpha, beta]);
    session("p-1", "s-1");
    session("p-2", "s-2");
    useTabsStore.getState().activate("p-1");
    render(<Sidebar />);
    expect(screen.getByText("Alpha").closest("[role=button]")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(
      screen.getByText("Beta").closest("[role=button]"),
    ).not.toHaveAttribute("data-selected");
    // A connection in the background can be disconnected too.
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Beta" }));
    expect(disconnectSession).toHaveBeenCalledWith("s-2");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Alpha" }));
    expect(disconnectSession).toHaveBeenCalledWith("s-1");
  });

  it("pulses a warning while a connection reconnects", () => {
    withProfiles([alpha]);
    session("p-1", "s-1", {
      status: "reconnecting",
      attempt: 2,
      maxAttempts: 5,
      nextRetryInSecs: 2,
    });
    render(<Sidebar />);
    const dot = screen.getByRole("img", {
      name: "Reconnecting (attempt 2 of 5)",
    });
    expect(dot).toHaveAttribute("data-tone", "warning");
    expect(dot).toHaveAttribute("data-pulse", "true");
  });

  it("connects or disconnects from the context menu", () => {
    withProfiles([alpha, beta]);
    session("p-2", "s-2");
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("Alpha"));
    expect(
      screen.queryByRole("menuitem", { name: "Connect in New Tab" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Connect" }));
    expect(openConnection).toHaveBeenCalledWith(alpha);
    fireEvent.contextMenu(screen.getByText("Beta"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(disconnectSession).toHaveBeenCalledWith("s-2");
  });

  it("edits from the context menu", () => {
    withProfiles([alpha]);
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("Alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit…" }));
    expect(useConnectionFormStore.getState()).toMatchObject({
      open: true,
      editing: alpha,
    });
  });

  it("deletes from the context menu after confirming", async () => {
    withProfiles([alpha]);
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("Alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));

    const dialog = screen.getByRole("dialog", { name: "Delete connection" });
    expect(dialog).toHaveTextContent("Delete Alpha?");
    expect(deleteProfile).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith("p-1"));
  });
});
