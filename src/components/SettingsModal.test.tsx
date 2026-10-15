import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

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
