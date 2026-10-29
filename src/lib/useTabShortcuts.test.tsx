import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no platform: pin one (Ctrl) so the tests do not depend on it.
const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("./platform", () => ({
  get isMac() {
    return platform.mac;
  },
  isWindows: false,
}));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listDir: vi.fn(() => Promise.resolve([])),
  homeDir: vi.fn(() => Promise.resolve("/home/alice")),
}));

import { initialPane, usePaneStore } from "../state/paneStore";
import { useSettingsStore } from "../state/settingsStore";
import { resetTabs, useTabsStore } from "../state/tabsStore";
import { useTabShortcuts } from "./useTabShortcuts";

const store = () => useTabsStore.getState();
const localTabs = () => store().local.tabs;
const remoteTabs = () => store().connections["p-1"]?.remote.tabs ?? [];

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
  platform.mac = false;
  localStorage.clear();
  useSettingsStore.getState().resetShortcuts();
  usePaneStore.setState({
    panes: { local: initialPane(), remote: initialPane() },
    active: "local",
  });
  resetTabs();
});

describe("useTabShortcuts", () => {
  it("opens a tab with the bound shortcut and follows a rebinding", () => {
    renderHook(() => useTabShortcuts());
    press({ key: "t", ctrlKey: true });
    expect(localTabs()).toHaveLength(2);
    act(() => useSettingsStore.getState().setShortcut("newTab", ["Mod+KeyN"]));
    press({ key: "t", ctrlKey: true });
    expect(localTabs()).toHaveLength(2);
    press({ key: "n", ctrlKey: true });
    expect(localTabs()).toHaveLength(3);
  });

  it("acts on the active pane's tabs", () => {
    renderHook(() => useTabShortcuts());
    act(() => {
      store().activate("p-1");
      store().attachSession("p-1", "s-1", "/srv");
      usePaneStore.getState().setActive("remote");
    });
    press({ key: "t", ctrlKey: true });
    press({ key: "t", ctrlKey: true });
    expect(remoteTabs()).toHaveLength(3);
    expect(localTabs()).toHaveLength(1);
    press({ key: "w", ctrlKey: true });
    expect(remoteTabs()).toHaveLength(2);

    act(() => usePaneStore.getState().setActive("local"));
    press({ key: "t", ctrlKey: true });
    expect(localTabs()).toHaveLength(2);
    expect(remoteTabs()).toHaveLength(2);
  });

  it("does nothing in the Remote pane without a connection", () => {
    renderHook(() => useTabShortcuts());
    act(() => usePaneStore.getState().setActive("remote"));
    press({ key: "t", ctrlKey: true });
    expect(localTabs()).toHaveLength(1);
    expect(store().connections).toEqual({});
  });

  it("opens, switches and closes tabs with Cmd on macOS", () => {
    platform.mac = true;
    renderHook(() => useTabShortcuts());
    const first = store().local.activeTabId;
    const active = () => store().local.activeTabId;
    const mod = { metaKey: true };
    press({ key: "t", ...mod });
    press({ key: "t", ...mod });
    expect(localTabs()).toHaveLength(3);
    press({ key: "1", ...mod });
    expect(active()).toBe(first);
    press({ key: "9", ...mod });
    expect(active()).toBe(localTabs()[2].id);
    press({ key: "2", ...mod });
    expect(active()).toBe(localTabs()[1].id);
    press({ key: "]", code: "BracketRight", shiftKey: true, ...mod });
    expect(active()).toBe(localTabs()[2].id);
    press({ key: "[", code: "BracketLeft", shiftKey: true, ...mod });
    expect(active()).toBe(localTabs()[1].id);
    press({ key: "w", ...mod });
    expect(localTabs()).toHaveLength(2);
    // Ctrl is not the modifier on macOS.
    press({ key: "t", ctrlKey: true });
    expect(localTabs()).toHaveLength(2);
  });

  it("leaves fields alone", () => {
    renderHook(() => useTabShortcuts());
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "t", ctrlKey: true }, input);
    expect(localTabs()).toHaveLength(1);
    input.remove();
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
