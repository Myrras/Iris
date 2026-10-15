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
    }),
  ),
  saveSettings: vi.fn((s: unknown) => Promise.resolve(s)),
}));

import { saveSettings } from "../ipc/commands";
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
    });
    expect(fewer).toBeDisabled();

    act(() =>
      useBackendSettingsStore.setState({
        settings: {
          parallelTransfers: 15,
          reconnectAttempts: 20,
          editorOverrides: {},
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
