import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom leaves `navigator.platform` empty, so pin the platform explicitly;
// each test picks one via `platform`. Getters, so a change is seen at render.
const platform = vi.hoisted(() => ({ mac: false, windows: false }));
vi.mock("./lib/platform", () => ({
  get isMac() {
    return platform.mac;
  },
  get isWindows() {
    return platform.windows;
  },
}));

// App wires up IPC on mount; jsdom has no Tauri bridge, so stub it out.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));
import { listen } from "@tauri-apps/api/event";
// WindowControls (Windows only) talks to the window API on mount.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => undefined),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));

import App from "./App";

/** The handler App registered for the global Tauri event `name`. */
function handlerFor(name: string) {
  return vi.mocked(listen).mock.calls.find(([event]) => event === name)?.[1];
}

function fire(name: string) {
  handlerFor(name)?.({ event: name, id: 0, payload: undefined });
}

beforeEach(() => {
  platform.mac = false;
  platform.windows = false;
  vi.mocked(listen).mockClear();
});

describe("App", () => {
  it("renders the island shell: brand, sidebar, both panes and transfers", () => {
    render(<App />);

    expect(screen.getByText("Iris")).toBeInTheDocument();
    expect(screen.getByText("No connections yet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Local files")).toBeInTheDocument();
    expect(screen.getByLabelText("Remote files")).toBeInTheDocument();
    expect(screen.getByLabelText("Transfers")).toBeInTheDocument();
  });

  it("shows the welcome content in the remote pane", () => {
    render(<App />);

    const remote = screen.getByLabelText("Remote files");
    expect(remote).toHaveTextContent("Welcome to Iris");
    expect(remote).toHaveTextContent("Connect to a server…");
  });

  it("opens Settings from the title-bar gear", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByLabelText("Settings"));
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("opens Settings with Ctrl+, off macOS", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.keyboard("{Control>},{/Control}");
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("opens Settings from the native macOS menu event", async () => {
    platform.mac = true;
    render(<App />);

    await waitFor(() => expect(handlerFor("menu:open-settings")).toBeDefined());
    fire("menu:open-settings");
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("raises the close warning when the backend blocks a quit", async () => {
    render(<App />);

    await waitFor(() =>
      expect(handlerFor("window:close-requested")).toBeDefined(),
    );
    fire("window:close-requested");
    expect(
      await screen.findByRole("dialog", { name: "Work still in progress" }),
    ).toBeInTheDocument();
  });

  it("draws its own window controls on Windows", () => {
    platform.windows = true;
    render(<App />);

    expect(screen.getByLabelText("Minimize")).toBeInTheDocument();
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
    expect(screen.getByLabelText("Settings")).toBeInTheDocument();
  });

  it("leaves the window controls to the native traffic lights on macOS", () => {
    platform.mac = true;
    render(<App />);

    expect(screen.queryByLabelText("Minimize")).toBeNull();
    expect(screen.queryByLabelText("Close")).toBeNull();
    // Settings lives in the native menu bar (⌘,) there.
    expect(screen.queryByLabelText("Settings")).toBeNull();
    expect(screen.getByText("Iris").closest("header")).toHaveAttribute(
      "data-tauri-drag-region",
      "true",
    );
  });
});
