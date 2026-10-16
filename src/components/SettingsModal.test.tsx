import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      parallelTransfers: 15,
      reconnectAttempts: 3,
      editorOverrides: {},
      syncExcludes: [".git"],
    }),
  ),
  saveSettings: vi.fn((s: unknown) => Promise.resolve(s)),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve("/Applications/Typora.app")),
}));
vi.mock("../lib/platform", () => ({ isMac: true, isWindows: false }));

import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { getSettings, saveSettings } from "../ipc/commands";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { useSettingsRequestStore } from "../state/settingsRequestStore";
import { DEFAULTS, useSettingsStore } from "../state/settingsStore";
import { useThemeStore } from "../state/themeStore";
import { SettingsModal } from "./SettingsModal";

describe("SettingsModal — General tab", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().resetSettings();
    useThemeStore.getState().setTheme("dark");
    useSettingsRequestStore.getState().clear();
  });

  it("opens on the General tab", () => {
    render(<SettingsModal open onClose={() => undefined} />);

    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Appearance")).toBeInTheDocument();
  });

  it("switches the theme and marks the active one", () => {
    render(<SettingsModal open onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Retro" }));
    expect(useThemeStore.getState().mode).toBe("retro");
    expect(localStorage.getItem("iris.theme")).toBe("retro");
    expect(screen.getByRole("button", { name: "Retro" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("persists the show-hidden toggle", () => {
    render(<SettingsModal open onClose={() => undefined} />);

    const toggle = screen.getByRole("switch", { name: "Show hidden files" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().browser.showHidden).toBe(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("toggles reduced motion", () => {
    render(<SettingsModal open onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));
    expect(useSettingsStore.getState().appearance.reduceMotion).toBe(true);
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
  });

  it("steps the preview size limit within its bounds", () => {
    render(<SettingsModal open onClose={() => undefined} />);

    const start = DEFAULTS.preview.maxSizeMb;
    expect(screen.getByText(`${start} MB`)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Increase preview size limit" }),
    );
    expect(useSettingsStore.getState().preview.maxSizeMb).toBe(start + 1);

    act(() => useSettingsStore.getState().set("preview", { maxSizeMb: 1 }));
    expect(
      screen.getByRole("button", { name: "Decrease preview size limit" }),
    ).toBeDisabled();
  });
});

describe("SettingsModal — Transfers tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBackendSettingsStore.setState({ settings: null });
    useSettingsRequestStore.getState().clear();
  });

  it("loads and steps parallel transfers up to 16", async () => {
    render(<SettingsModal open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Transfers" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Parallel transfers")).toHaveTextContent(
        "15",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Increase parallel transfers" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Parallel transfers")).toHaveTextContent(
        "16",
      ),
    );
    expect(saveSettings).toHaveBeenCalledWith({
      parallelTransfers: 16,
      reconnectAttempts: 3,
      editorOverrides: {},
      syncExcludes: [".git"],
    });
    expect(
      screen.getByRole("button", { name: "Increase parallel transfers" }),
    ).toBeDisabled();
  });

  it("steps reconnect attempts down to off and up to 20", async () => {
    render(<SettingsModal open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Transfers" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Reconnect attempts")).toHaveTextContent(
        "3",
      ),
    );
    const fewer = screen.getByRole("button", {
      name: "Decrease reconnect attempts",
    });
    for (const expected of ["2", "1", "Off"]) {
      fireEvent.click(fewer);
      await waitFor(() =>
        expect(screen.getByLabelText("Reconnect attempts")).toHaveTextContent(
          expected,
        ),
      );
    }
    expect(saveSettings).toHaveBeenLastCalledWith({
      parallelTransfers: 15,
      reconnectAttempts: 0,
      editorOverrides: {},
      syncExcludes: [".git"],
    });
    expect(fewer).toBeDisabled();

    act(() =>
      useBackendSettingsStore.setState({
        settings: {
          parallelTransfers: 15,
          reconnectAttempts: 20,
          editorOverrides: {},
          syncExcludes: [".git"],
        },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Increase reconnect attempts" }),
    ).toBeDisabled();
  });

  it("opens on the Transfers tab when asked to", () => {
    useSettingsRequestStore.getState().open("transfers");
    render(<SettingsModal open onClose={() => undefined} />);
    expect(screen.getByRole("tab", { name: "Transfers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("SettingsModal — Sync excludes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBackendSettingsStore.setState({ settings: null });
    useSettingsRequestStore.getState().clear();
  });

  async function openTransfers() {
    render(<SettingsModal open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Transfers" }));
    await screen.findByText(".git");
  }

  it("lists, adds and removes patterns", async () => {
    await openTransfers();
    expect(screen.getByText("Sync excludes")).toBeInTheDocument();
    const input = screen.getByRole("textbox", {
      name: "Name or pattern to exclude",
    });
    fireEvent.change(input, { target: { value: " *.log " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(saveSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncExcludes: [".git", "*.log"] }),
      ),
    );
    expect(await screen.findByText("*.log")).toBeInTheDocument();
    expect(input).toHaveValue("");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove the sync exclude .git" }),
    );
    await waitFor(() =>
      expect(saveSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ syncExcludes: ["*.log"] }),
      ),
    );
  });

  it("refuses separators and repeats", async () => {
    await openTransfers();
    const input = screen.getByRole("textbox", {
      name: "Name or pattern to exclude",
    });
    fireEvent.change(input, { target: { value: "build/out" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("no / or \\");
    fireEvent.change(input, { target: { value: ".git" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already excluded");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("restores the defaults", async () => {
    await openTransfers();
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    await waitFor(() =>
      expect(saveSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          syncExcludes: [".git", ".DS_Store", "node_modules", "Thumbs.db"],
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Restore defaults" }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("SettingsModal — Editors tab", () => {
  const settings = (editorOverrides: Record<string, string>) => ({
    parallelTransfers: 15,
    reconnectAttempts: 3,
    editorOverrides,
    syncExcludes: [".git"],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useBackendSettingsStore.setState({ settings: null });
    useSettingsRequestStore.getState().clear();
  });

  async function openEditors() {
    render(<SettingsModal open onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Editors" }));
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
  }

  it("says files open in their default app when nothing is set", async () => {
    await openEditors();
    expect(
      await screen.findByText(
        "No editors set: every file opens in its default app.",
      ),
    ).toBeInTheDocument();
  });

  it("adds an editor picked with the dialog, stored lower-case without the dot", async () => {
    await openEditors();
    fireEvent.click(await screen.findByRole("button", { name: "Add editor" }));
    fireEvent.change(screen.getByLabelText("Extension"), {
      target: { value: " .MD " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Application")).toHaveValue(
        "/Applications/Typora.app",
      ),
    );
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        filters: [{ name: "Applications", extensions: ["app"] }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        settings({ md: "/Applications/Typora.app" }),
      ),
    );
    expect(await screen.findByText(".md")).toBeInTheDocument();
    expect(screen.getByText("Typora")).toBeInTheDocument();
  });

  it("validates the extension and the application inline", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(
      settings({ md: "/Applications/Typora.app" }),
    );
    await openEditors();
    fireEvent.click(await screen.findByRole("button", { name: "Add editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter an extension, like md.",
    );
    fireEvent.change(screen.getByLabelText("Extension"), {
      target: { value: "tar.gz" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("single extension");
    fireEvent.change(screen.getByLabelText("Extension"), {
      target: { value: "MD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      ".md already has an editor.",
    );
    fireEvent.change(screen.getByLabelText("Extension"), {
      target: { value: "txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose an application.",
    );
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("edits and removes a row", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce(
      settings({
        md: "/Applications/Typora.app",
        yml: "/Applications/Code.app",
      }),
    );
    vi.mocked(openDialog).mockResolvedValueOnce("/Applications/Zed.app");
    await openEditors();
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit the .md editor" }),
    );
    expect(screen.getByLabelText("Extension")).toHaveValue("md");
    fireEvent.change(screen.getByLabelText("Extension"), {
      target: { value: "markdown" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Application")).toHaveValue(
        "/Applications/Zed.app",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveSettings).toHaveBeenLastCalledWith(
        settings({
          markdown: "/Applications/Zed.app",
          yml: "/Applications/Code.app",
        }),
      ),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove the .yml editor" }),
    );
    await waitFor(() =>
      expect(saveSettings).toHaveBeenLastCalledWith(
        settings({ markdown: "/Applications/Zed.app" }),
      ),
    );
    await waitFor(() => expect(screen.queryByText(".yml")).toBeNull());
  });

  it("cancels an edit without saving", async () => {
    await openEditors();
    fireEvent.click(await screen.findByRole("button", { name: "Add editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Extension")).toBeNull();
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
