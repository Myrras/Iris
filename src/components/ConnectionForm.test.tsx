import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  saveProfile: vi.fn(),
  listProfiles: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../lib/connect", () => ({ connectProfile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve("/home/alice/.ssh/id_example")),
}));

import { saveProfile } from "../ipc/commands";
import type { ConnectionProfile } from "../ipc/types";
import { connectProfile } from "../lib/connect";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { ConnectionForm } from "./ConnectionForm";

const saved: ConnectionProfile = {
  id: "p-1",
  name: "alice@alpha.example.test",
  host: "alpha.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "password" },
  startDir: null,
};

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  useConnectionFormStore.setState({ open: false, editing: null });
});

function openNew() {
  render(<ConnectionForm />);
  useConnectionFormStore.getState().openNew();
}

describe("ConnectionForm", () => {
  it("shows the problems inline after trying to save", async () => {
    openNew();
    await screen.findByRole("dialog", { name: "New connection" });
    expect(screen.queryByText("Enter a host.")).toBeNull();

    type("Port", "70000");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("Enter a host.")).toBeInTheDocument();
    expect(screen.getByText("Enter a user name.")).toBeInTheDocument();
    expect(screen.getByText("Use a port from 1 to 65535.")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(saveProfile).not.toHaveBeenCalled();

    // Errors update live once shown.
    type("Host", "alpha.example.test");
    expect(screen.queryByText("Enter a host.")).toBeNull();
  });

  it("saves a password connection and closes", async () => {
    vi.mocked(saveProfile).mockResolvedValue(saved);
    openNew();
    await screen.findByRole("dialog", { name: "New connection" });
    type("Host", "alpha.example.test");
    type("User", "alice");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(useConnectionFormStore.getState().open).toBe(false),
    );
    expect(saveProfile).toHaveBeenCalledWith({
      name: "",
      host: "alpha.example.test",
      user: "alice",
      auth: { kind: "password" },
      startDir: null,
    });
    expect(connectProfile).not.toHaveBeenCalled();
  });

  it("connects after Save & Connect", async () => {
    vi.mocked(saveProfile).mockResolvedValue(saved);
    openNew();
    await screen.findByRole("dialog", { name: "New connection" });
    type("Host", "alpha.example.test");
    type("User", "alice");
    fireEvent.click(screen.getByRole("button", { name: "Save & Connect" }));
    await waitFor(() => expect(connectProfile).toHaveBeenCalledWith(saved));
  });

  it("takes a key file from the picker", async () => {
    vi.mocked(saveProfile).mockResolvedValue(saved);
    openNew();
    await screen.findByRole("dialog", { name: "New connection" });
    fireEvent.click(screen.getByRole("radio", { name: "Key file" }));
    expect(screen.getByRole("radio", { name: "Key file" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Private key")).toHaveValue(
        "/home/alice/.ssh/id_example",
      ),
    );
    type("Host", "alpha.example.test");
    type("User", "alice");
    type("Port", "2222");
    type("Start folder (optional)", "/srv");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveProfile).toHaveBeenCalledWith({
        name: "",
        host: "alpha.example.test",
        port: 2222,
        user: "alice",
        auth: { kind: "keyFile", path: "/home/alice/.ssh/id_example" },
        startDir: "/srv",
      }),
    );
  });

  it("shows a backend rejection inline and stays open", async () => {
    vi.mocked(saveProfile).mockRejectedValue({
      kind: "invalidInput",
      message: "port must be between 1 and 65535",
    });
    openNew();
    await screen.findByRole("dialog", { name: "New connection" });
    type("Host", "alpha.example.test");
    type("User", "alice");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "port must be between 1 and 65535",
    );
    expect(useConnectionFormStore.getState().open).toBe(true);
  });

  it("edits an existing connection", async () => {
    vi.mocked(saveProfile).mockResolvedValue(saved);
    render(<ConnectionForm />);
    useConnectionFormStore
      .getState()
      .openEdit({ ...saved, name: "Alpha", port: 2200 });
    await screen.findByRole("dialog", { name: "Edit connection" });
    expect(screen.getByLabelText("Name (optional)")).toHaveValue("Alpha");
    expect(screen.getByLabelText("Port")).toHaveValue("2200");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveProfile).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p-1", name: "Alpha", port: 2200 }),
      ),
    );
  });
});
