import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no platform: pin one (Ctrl) so the tests do not depend on it.
vi.mock("./platform", () => ({ isMac: false, isWindows: false }));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));

import { useSettingsStore } from "../state/settingsStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { useTabShortcuts } from "./useTabShortcuts";

const tabs = () => useTabsStore.getState().tabs;

function press(
  init: KeyboardEventInit & { key: string },
  target: EventTarget = window,
) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetShortcuts();
  resetTabs();
});

describe("useTabShortcuts", () => {
  it("opens a tab with the bound shortcut and follows a rebinding", () => {
    renderHook(() => useTabShortcuts());
    press({ key: "t", ctrlKey: true });
    expect(tabs()).toHaveLength(2);
    act(() => useSettingsStore.getState().setShortcut("newTab", ["Mod+KeyN"]));
    press({ key: "t", ctrlKey: true });
    expect(tabs()).toHaveLength(2);
    press({ key: "n", ctrlKey: true });
    expect(tabs()).toHaveLength(3);
  });

  it("opens Settings off macOS, also from a field", () => {
    const onOpenSettings = vi.fn();
    renderHook(() => useTabShortcuts({ onOpenSettings }));
    const e = press({ key: ",", code: "Comma", ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: ",", code: "Comma", ctrlKey: true }, input);
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it("swallows reload, print and find wherever the focus is", () => {
    renderHook(() => useTabShortcuts());
    const input = document.createElement("input");
    document.body.appendChild(input);
    for (const init of [
      { key: "F5" },
      { key: "r", ctrlKey: true },
      { key: "R", ctrlKey: true, shiftKey: true },
      { key: "p", ctrlKey: true },
      { key: "f", ctrlKey: true },
    ]) {
      expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(true);
      expect(press(init, input).defaultPrevented).toBe(true);
    }
    // Plain typing is left alone.
    expect(press({ key: "r" }, input).defaultPrevented).toBe(false);
    input.remove();
  });

  it("still swallows Ctrl+P after Go to path is moved away from it", () => {
    renderHook(() => useTabShortcuts());
    act(() => useSettingsStore.getState().setShortcut("goTo", ["Mod+KeyK"]));
    expect(press({ key: "p", ctrlKey: true }).defaultPrevented).toBe(true);
  });
});
