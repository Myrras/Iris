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
}));
vi.mock("../lib/connect", () => ({
  connectProfile: vi.fn(),
  disconnectSession: vi.fn(),
}));

import { deleteProfile } from "../ipc/commands";
import type { ConnectionProfile } from "../ipc/types";
import { connectProfile, disconnectSession } from "../lib/connect";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
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
};
const beta: ConnectionProfile = { ...alpha, id: "p-2", name: "Beta" };

function withProfiles(profiles: ConnectionProfile[]) {
  useProfilesStore.setState({ profiles, loaded: true });
}

beforeEach(() => {
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
    expect(buttons).toEqual(["Connections", "New connection…"]);
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

  it("lists saved connections with their state", () => {
    withProfiles([alpha, beta]);
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state: "connected",
      reason: null,
    });
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-2",
      profileId: "p-2",
      state: "disconnected",
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

  it("connects on click", () => {
    withProfiles([alpha]);
    render(<Sidebar />);
    fireEvent.click(screen.getByText("Alpha"));
    expect(connectProfile).toHaveBeenCalledWith(alpha);
  });

  it("marks the connection shown in the remote pane", () => {
    withProfiles([alpha, beta]);
    useSessionStore.getState().apply({
      type: "sessionStateChanged",
      sessionId: "s-1",
      profileId: "p-1",
      state: "connected",
      reason: null,
    });
    usePaneStore.setState((s) => ({
      panes: {
        ...s.panes,
        remote: {
          ...s.panes.remote,
          target: { kind: "remote", sessionId: "s-1" },
        },
      },
    }));
    render(<Sidebar />);
    expect(screen.getByText("Alpha").closest("[role=button]")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(
      screen.getByText("Beta").closest("[role=button]"),
    ).not.toHaveAttribute("data-selected");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Alpha" }));
    expect(disconnectSession).toHaveBeenCalledWith("s-1");
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
