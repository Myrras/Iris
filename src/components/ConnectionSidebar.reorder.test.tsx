/** Reordering the saved connections: drag, keyboard and menu. */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The "backend": reorderProfiles stores the order, listProfiles reads it.
const backend = vi.hoisted(() => ({
  profiles: [] as unknown[],
  fail: false,
}));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listProfiles: vi.fn(() => Promise.resolve(backend.profiles)),
  reorderProfiles: vi.fn((ids: string[]) => {
    if (backend.fail) {
      return Promise.reject({ kind: "invalidInput", message: "refused" });
    }
    const all = backend.profiles as ConnectionProfile[];
    backend.profiles = ids.map((id) => all.find((p) => p.id === id)!);
    return Promise.resolve();
  }),
}));
vi.mock("../lib/connect", () => ({
  openConnection: vi.fn(),
  disconnectSession: vi.fn(),
}));

import { listProfiles, reorderProfiles } from "../ipc/commands";
import type { ConnectionProfile } from "../ipc/types";
import { openConnection } from "../lib/connect";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { resetTabs } from "../state/tabsStore";
import { useToastStore } from "../state/toastStore";
import { ConnectionSidebar } from "./ConnectionSidebar";

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
const gamma: ConnectionProfile = { ...alpha, id: "p-3", name: "Gamma" };

const ROW_H = 28;

/** jsdom has no layout: rows are 28px tall, stacked from the top. */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const index = this.parentElement
        ? Array.from(this.parentElement.children).indexOf(this)
        : 0;
      const top = this.getAttribute("role") === "listitem" ? index * ROW_H : 0;
      return {
        top,
        bottom: top + ROW_H,
        left: 0,
        right: 200,
        width: 200,
        height: ROW_H,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    },
  );
}

function setOrder(profiles: ConnectionProfile[]) {
  backend.profiles = profiles;
  useProfilesStore.setState({ profiles, loaded: true });
}

const names = () =>
  within(screen.getByRole("list", { name: "Saved connections" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

const row = (name: string) =>
  screen.getByText(name).closest<HTMLElement>('[role="button"]')!;

const items = () =>
  within(screen.getByRole("list", { name: "Saved connections" })).getAllByRole(
    "listitem",
  );

/** Press `name`'s row, then move the pointer to each `y` in turn. */
function press(name: string, ...ys: number[]) {
  const from = names().indexOf(name);
  fireEvent.mouseDown(row(name), {
    button: 0,
    clientX: 20,
    clientY: from * ROW_H + 14,
  });
  for (const y of ys) fireEvent.mouseMove(window, { clientX: 20, clientY: y });
}

const ctrlAlt = { ctrlKey: true, altKey: true };

beforeEach(() => {
  vi.clearAllMocks();
  backend.fail = false;
  resetTabs();
  useSessionStore.setState({ sessions: {} });
  useToastStore.setState({ toasts: [] });
  setOrder([alpha, beta, gamma]);
  stubLayout();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A drag left running by a failing test must not leak into the next.
  fireEvent.mouseUp(window);
  delete document.documentElement.dataset.dragging;
  // A drop's click guard lives until the next task; let it go.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("reordering connections by dragging", () => {
  it("drops a row where the line shows and sends the new order", async () => {
    render(<ConnectionSidebar />);
    // Past the 4px threshold, then over the lower half of the last row.
    press("Alpha", 20, 80);
    expect(document.documentElement.dataset.dragging).toBe("reorder");
    expect(row("Alpha")).toHaveAttribute("data-reordering", "true");
    // After the last row: the line sits on its bottom edge.
    fireEvent.mouseMove(window, { clientX: 20, clientY: 90 });
    expect(items()[2]).toHaveAttribute("data-insert", "after");
    fireEvent.mouseUp(window);

    expect(reorderProfiles).toHaveBeenCalledWith(["p-2", "p-3", "p-1"]);
    expect(document.documentElement.dataset.dragging).toBeUndefined();
    // Applied at once, and the list is re-read afterwards.
    expect(names()).toEqual(["Beta", "Gamma", "Alpha"]);
    await waitFor(() => expect(listProfiles).toHaveBeenCalled());
    expect(names()).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("moves a row up to between two others", () => {
    render(<ConnectionSidebar />);
    // The upper half of Beta (y 28..56) is "before Beta".
    press("Gamma", 2 * ROW_H, 30);
    expect(items()[1]).toHaveAttribute("data-insert", "before");
    fireEvent.mouseUp(window);
    expect(reorderProfiles).toHaveBeenCalledWith(["p-1", "p-3", "p-2"]);
  });

  it("shows no line, and sends nothing, over the row's own place", () => {
    render(<ConnectionSidebar />);
    press("Beta", 1 * ROW_H + 20, 1 * ROW_H + 22);
    expect(document.documentElement.dataset.dragging).toBe("reorder");
    expect(items().some((li) => li.hasAttribute("data-insert"))).toBe(false);
    fireEvent.mouseUp(window);
    expect(reorderProfiles).not.toHaveBeenCalled();
  });

  it("sets the dragging mark while it runs, clears it after, and leaves a pane's alone", () => {
    render(<ConnectionSidebar />);
    expect(document.documentElement.dataset.dragging).toBeUndefined();
    press("Alpha", 30);
    expect(document.documentElement.dataset.dragging).toBe("reorder");
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.mouseUp(window);
    expect(document.documentElement.dataset.dragging).toBeUndefined();
    expect(document.body.style.userSelect).toBe("");
  });

  it("does not start below the 4px threshold; the click still connects", () => {
    render(<ConnectionSidebar />);
    press("Alpha", 15);
    expect(document.documentElement.dataset.dragging).toBeUndefined();
    fireEvent.mouseUp(window);
    fireEvent.click(row("Alpha"));
    expect(openConnection).toHaveBeenCalledWith(alpha);
    expect(reorderProfiles).not.toHaveBeenCalled();
  });

  it("does not turn the release of a drag into a connect", () => {
    render(<ConnectionSidebar />);
    press("Alpha", 20, 90);
    fireEvent.mouseUp(window);
    fireEvent.click(row("Alpha"));
    expect(openConnection).not.toHaveBeenCalled();
  });

  it("cancels on Escape: nothing is sent, the release does not connect", () => {
    render(<ConnectionSidebar />);
    press("Alpha", 20, 90);
    expect(items()[2]).toHaveAttribute("data-insert", "after");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.documentElement.dataset.dragging).toBeUndefined();
    expect(items().some((li) => li.hasAttribute("data-insert"))).toBe(false);
    expect(row("Alpha")).not.toHaveAttribute("data-reordering");

    // Moving on and releasing is no drop, and its click is not a connect.
    fireEvent.mouseMove(window, { clientX: 20, clientY: 40 });
    fireEvent.mouseUp(window);
    fireEvent.click(row("Alpha"));
    expect(reorderProfiles).not.toHaveBeenCalled();
    expect(openConnection).not.toHaveBeenCalled();
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("ignores the row's own buttons and other mouse buttons", () => {
    render(<ConnectionSidebar />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Edit Alpha" }), {
      button: 0,
      clientX: 20,
      clientY: 14,
    });
    fireEvent.mouseMove(window, { clientX: 20, clientY: 90 });
    expect(document.documentElement.dataset.dragging).toBeUndefined();

    fireEvent.mouseDown(row("Beta"), { button: 2, clientX: 20, clientY: 42 });
    fireEvent.mouseMove(window, { clientX: 20, clientY: 90 });
    expect(document.documentElement.dataset.dragging).toBeUndefined();
  });

  it("scrolls the list near its edge and follows the rows under the pointer", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    try {
      const { container } = render(
        <div data-testid="scroller" style={{ overflowY: "auto" }}>
          <ConnectionSidebar />
        </div>,
      );
      const scroller = container.firstElementChild as HTMLElement;
      // The scroller spans 0..84, the rows' own area, so y 80 is at its edge.
      scroller.getBoundingClientRect = () =>
        ({ top: 0, bottom: 84, height: 84 }) as DOMRect;
      let top = 0;
      Object.defineProperty(scroller, "scrollTop", {
        get: () => top,
        set: (v: number) => {
          top = Math.min(100, Math.max(0, v));
        },
      });
      press("Alpha", 20, 80);
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(scroller.scrollTop).toBeGreaterThan(0);
      fireEvent.mouseUp(window);
      const after = scroller.scrollTop;
      act(() => {
        vi.advanceTimersByTime(100);
      });
      // No more scrolling once the drag is over.
      expect(scroller.scrollTop).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a drag when the list changes under it", () => {
    render(<ConnectionSidebar />);
    press("Alpha", 20, 90);
    act(() => setOrder([beta, alpha]));
    expect(document.documentElement.dataset.dragging).toBeUndefined();
    fireEvent.mouseUp(window);
    expect(reorderProfiles).not.toHaveBeenCalled();
  });
});

describe("reordering connections with the keyboard", () => {
  it("moves the focused row one place with Option+Cmd+Up / Down", async () => {
    render(<ConnectionSidebar />);
    row("Beta").focus();
    fireEvent.keyDown(row("Beta"), {
      key: "ArrowUp",
      code: "ArrowUp",
      ...ctrlAlt,
    });
    expect(reorderProfiles).toHaveBeenLastCalledWith(["p-2", "p-1", "p-3"]);
    expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
    // Focus stays on the moved row.
    await waitFor(() => expect(document.activeElement).toBe(row("Beta")));

    fireEvent.keyDown(row("Beta"), {
      key: "ArrowDown",
      code: "ArrowDown",
      ...ctrlAlt,
    });
    expect(reorderProfiles).toHaveBeenLastCalledWith(["p-1", "p-2", "p-3"]);
  });

  it("stops at the first and the last place", () => {
    render(<ConnectionSidebar />);
    fireEvent.keyDown(row("Alpha"), {
      key: "ArrowUp",
      code: "ArrowUp",
      ...ctrlAlt,
    });
    fireEvent.keyDown(row("Gamma"), {
      key: "ArrowDown",
      code: "ArrowDown",
      ...ctrlAlt,
    });
    expect(reorderProfiles).not.toHaveBeenCalled();
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("leaves plain arrows and other modifiers alone", () => {
    render(<ConnectionSidebar />);
    for (const mods of [{}, { altKey: true }, { ctrlKey: true }]) {
      fireEvent.keyDown(row("Beta"), {
        key: "ArrowUp",
        code: "ArrowUp",
        ...mods,
      });
    }
    expect(reorderProfiles).not.toHaveBeenCalled();
  });
});

describe("reordering connections from the menu", () => {
  const openMenu = (name: string) =>
    fireEvent.contextMenu(screen.getByText(name));

  it("moves a row with Move Up / Move Down", () => {
    render(<ConnectionSidebar />);
    openMenu("Beta");
    fireEvent.click(screen.getByRole("menuitem", { name: /^Move Down/ }));
    expect(reorderProfiles).toHaveBeenLastCalledWith(["p-1", "p-3", "p-2"]);
  });

  it("moves up, and shows the shortcut", () => {
    render(<ConnectionSidebar />);
    openMenu("Gamma");
    const up = screen.getByRole("menuitem", { name: /^Move Up/ });
    expect(up).toHaveTextContent("Ctrl+Alt+↑");
    fireEvent.click(up);
    expect(reorderProfiles).toHaveBeenLastCalledWith(["p-1", "p-3", "p-2"]);
  });

  it("disables Move Up on the first row and Move Down on the last", () => {
    render(<ConnectionSidebar />);
    openMenu("Alpha");
    expect(screen.getByRole("menuitem", { name: /^Move Up/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /^Move Down/ })).toBeEnabled();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.body);
  });

  it("disables Move Down on the last row", () => {
    render(<ConnectionSidebar />);
    openMenu("Gamma");
    expect(screen.getByRole("menuitem", { name: /^Move Down/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /^Move Up/ })).toBeEnabled();
  });
});

describe("a refused reorder", () => {
  it("toasts and puts the backend's order back", async () => {
    backend.fail = true;
    render(<ConnectionSidebar />);
    fireEvent.keyDown(row("Gamma"), {
      key: "ArrowUp",
      code: "ArrowUp",
      ...ctrlAlt,
    });
    // Applied locally first …
    expect(names()).toEqual(["Alpha", "Gamma", "Beta"]);
    // … then reverted to what the backend still has.
    await waitFor(() => expect(names()).toEqual(["Alpha", "Beta", "Gamma"]));
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "Could not reorder connections",
        detail: "refused",
      }),
    ]);
  });
});
