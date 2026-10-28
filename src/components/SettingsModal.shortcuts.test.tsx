import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      parallelTransfers: 4,
      reconnectAttempts: 3,
      editorOverrides: {},
      syncExcludes: [],
    }),
  ),
}));
vi.mock("../lib/platform", () => ({ isMac: true, isWindows: false }));

import { useSettingsRequestStore } from "../state/settingsRequestStore";
import { useSettingsStore } from "../state/settingsStore";
import { SettingsModal } from "./SettingsModal";

const stored = () =>
  JSON.parse(localStorage.getItem("iris.settings") ?? "{}").shortcuts;

const onClose = vi.fn();

function renderTab() {
  render(<SettingsModal open onClose={onClose} />);
  fireEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
}

const row = (label: string) => screen.getByRole("group", { name: label });
const keys = (label: string) =>
  Array.from(row(label).querySelectorAll("kbd")).map((k) => k.textContent);
const record = (label: string) =>
  fireEvent.click(
    within(row(label)).getByRole("button", { name: /^Record shortcut/ }),
  );
/** A key press while recording (the recorder listens on `window`). */
function press(init: KeyboardEventInit & { key: string }) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.getState().resetSettings();
  useSettingsRequestStore.getState().clear();
});

describe("SettingsModal — Shortcuts tab", () => {
  it("lists the actions with their default bindings", () => {
    renderTab();
    expect(keys("Go to path")).toEqual(["⌘P", "⌘L"]);
    expect(keys("Refresh")).toEqual(["⌘R"]);
    expect(keys("Find (filter)")).toEqual(["⌘F"]);
    expect(keys("New folder")).toEqual(["⇧⌘N"]);
    expect(keys("Sync folders")).toEqual(["⌥⌘S"]);
    expect(keys("New tab")).toEqual(["⌘T"]);
    // The native menu owns ⌘, on macOS.
    expect(screen.queryByRole("group", { name: "Open Settings" })).toBeNull();
  });

  it("opens from a settings request", () => {
    useSettingsRequestStore.getState().open("shortcuts");
    render(<SettingsModal open onClose={() => undefined} />);
    expect(screen.getByRole("tab", { name: "Shortcuts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("records a new binding and stores only that change", () => {
    renderTab();
    record("Go to path");
    expect(within(row("Go to path")).getByText("Press keys…")).toBeVisible();
    // A modifier on its own keeps waiting.
    press({ key: "Meta", metaKey: true });
    expect(within(row("Go to path")).getByText("Press keys…")).toBeVisible();
    const e = press({ key: "k", code: "KeyK", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(keys("Go to path")).toEqual(["⌘K"]);
    expect(stored()).toEqual({ goTo: ["Mod+KeyK"] });
    expect(useSettingsStore.getState().shortcuts).toEqual({
      goTo: ["Mod+KeyK"],
    });
  });

  it("records Option combinations by the physical key", () => {
    renderTab();
    record("Toggle preview");
    press({ key: "ø", code: "KeyO", metaKey: true, altKey: true });
    expect(keys("Toggle preview")).toEqual(["⌥⌘O"]);
  });

  it("cancels with Escape without closing the dialog", () => {
    renderTab();
    record("Refresh");
    onClose.mockClear();
    press({ key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(within(row("Refresh")).queryByText("Press keys…")).toBeNull();
    expect(keys("Refresh")).toEqual(["⌘R"]);
  });

  it("refuses a combination another action uses, and offers a swap", () => {
    renderTab();
    record("Go to path");
    press({ key: "r", code: "KeyR", metaKey: true });
    expect(within(row("Go to path")).getByRole("alert")).toHaveTextContent(
      "⌘R is already used by Refresh.",
    );
    expect(keys("Go to path")).toEqual(["⌘P", "⌘L"]);
    expect(keys("Refresh")).toEqual(["⌘R"]);
    expect(useSettingsStore.getState().shortcuts).toEqual({});

    fireEvent.click(screen.getByRole("button", { name: "Swap them" }));
    expect(keys("Go to path")).toEqual(["⌘R"]);
    expect(keys("Refresh")).toEqual(["⌘P", "⌘L"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses an alias of another action too", () => {
    renderTab();
    record("Refresh");
    press({ key: "l", code: "KeyL", metaKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "⌘L is already used by Go to path.",
    );
  });

  it("refuses fixed keys, bare letters and Escape-less combos, and keeps recording", () => {
    renderTab();
    record("Refresh");
    press({ key: "a", code: "KeyA", metaKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "⌘A is fixed (Select all).",
    );
    press({ key: "k", code: "KeyK" });
    expect(screen.getByRole("alert")).toHaveTextContent("Hold ⌘ or ⌥");
    // Still recording: the next valid press is taken.
    press({ key: "j", code: "KeyJ", metaKey: true });
    expect(keys("Refresh")).toEqual(["⌘J"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes function keys and Delete on their own", () => {
    renderTab();
    record("Rename");
    press({ key: "F6", code: "F6" });
    expect(keys("Rename")).toEqual(["F6"]);
  });

  it("resets a row and everything", () => {
    renderTab();
    const reset = (label: string) =>
      within(row(label)).getByRole("button", { name: `Reset ${label}` });
    expect(reset("Refresh")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset all" })).toBeDisabled();

    record("Refresh");
    press({ key: "j", code: "KeyJ", metaKey: true });
    record("Find (filter)");
    press({ key: "k", code: "KeyK", metaKey: true });
    expect(screen.getByRole("button", { name: "Reset all" })).toBeEnabled();

    fireEvent.click(reset("Refresh"));
    expect(keys("Refresh")).toEqual(["⌘R"]);
    expect(stored()).toEqual({ find: ["Mod+KeyK"] });

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(keys("Find (filter)")).toEqual(["⌘F"]);
    expect(stored()).toEqual({});
  });

  it("does not store a binding equal to the default", () => {
    renderTab();
    record("Refresh");
    press({ key: "j", code: "KeyJ", metaKey: true });
    record("Refresh");
    press({ key: "r", code: "KeyR", metaKey: true });
    expect(keys("Refresh")).toEqual(["⌘R"]);
    expect(stored()).toEqual({});
  });

  it("keeps the shortcuts after a reload", async () => {
    renderTab();
    record("Refresh");
    press({ key: "j", code: "KeyJ", metaKey: true });
    vi.resetModules();
    const fresh = (await import("../state/settingsStore")).useSettingsStore;
    expect(fresh.getState().shortcuts).toEqual({ refresh: ["Mod+KeyJ"] });
  });
});
