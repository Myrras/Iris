import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The islands are not under test here, only the frame around them.
vi.mock("./Pane", () => ({
  Pane: ({ id }: { id: string }) => <div data-testid={`pane-${id}`} />,
}));
vi.mock("./PreviewPanel", () => ({
  PreviewPanel: () => <div data-testid="preview" />,
}));
vi.mock("./Sidebar", () => ({ Sidebar: () => <aside /> }));
vi.mock("./TransferPanel", () => ({
  TransferPanel: () => <section aria-label="Transfers" />,
}));

import { stubPointerEvents } from "../test/pointer";
import { useLayoutStore } from "../state/layoutStore";
import { Shell } from "./Shell";

const GAP = 8;

function setWindow(width: number, height: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
}

/** Layout variables on the shell container. */
function vars() {
  const el = document.querySelector<HTMLElement>("[class*='body']")!;
  const get = (name: string) => el.style.getPropertyValue(name);
  return {
    sidebar: get("--sidebar-w"),
    preview: get("--preview-w"),
    transfers: get("--transfers-list-h"),
    local: Number(get("--pane-local-grow")),
    remote: Number(get("--pane-remote-grow")),
  };
}

function separator(name: RegExp) {
  return screen.getByRole("separator", { name });
}

let frames: FrameRequestCallback[] = [];
function flushFrames() {
  const run = frames;
  frames = [];
  run.forEach((cb) => cb(0));
}

function resetStore(patch: Record<string, unknown> = {}) {
  localStorage.clear();
  useLayoutStore.setState({
    sidebarWidth: 280,
    panesRatio: 0.5,
    previewWidth: 340,
    previewOpen: true,
    transfersHeight: 168,
    transfersCollapsed: false,
    ...patch,
  });
}

beforeEach(() => {
  frames = [];
  stubPointerEvents();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  setWindow(1600, 900);
  resetStore();
});

afterEach(() => vi.unstubAllGlobals());

describe("Shell", () => {
  it("lays the islands out with the stored sizes", () => {
    resetStore({
      sidebarWidth: 300,
      previewWidth: 400,
      transfersHeight: 220,
      panesRatio: 0.6,
    });
    render(<Shell />);
    const v = vars();
    expect(v.sidebar).toBe("300px");
    expect(v.preview).toBe("400px");
    expect(v.transfers).toBe("220px");
    expect(v.local).toBe(600);
    expect(v.remote).toBe(400);
    expect(separator(/sidebar/i)).toHaveAttribute("aria-valuenow", "300");
    expect(separator(/preview/i)).toHaveAttribute("aria-valuenow", "400");
    expect(separator(/transfers/i)).toHaveAttribute("aria-valuenow", "220");
  });

  it("moves the sidebar while dragging through CSS variables and saves on release", () => {
    render(<Shell />);
    const sep = separator(/sidebar/i);
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX: 300 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 360 });
    act(() => flushFrames());
    expect(vars().sidebar).toBe("340px");
    // Nothing is stored (and nothing re-rendered) until the release.
    expect(useLayoutStore.getState().sidebarWidth).toBe(280);
    expect(localStorage.getItem("iris.layout")).toBeNull();
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(useLayoutStore.getState().sidebarWidth).toBe(340);
    expect(JSON.parse(localStorage.getItem("iris.layout")!).sidebarWidth).toBe(
      340,
    );
    expect(vars().sidebar).toBe("340px");
    expect(sep).toHaveAttribute("aria-valuenow", "340");
  });

  it("splits the panes by a stored ratio, each at least 280 px", () => {
    render(<Shell />);
    const total = 1600 - 5 * GAP - 280 - 340;
    const sep = separator(/local and remote/i);
    expect(sep).toHaveAttribute("aria-valuemin", "280");
    expect(sep).toHaveAttribute("aria-valuemax", String(total - 280));
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX: 600 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 750 });
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(useLayoutStore.getState().panesRatio).toBeCloseTo(
      (total / 2 + 150) / total,
      4,
    );
    // Too far: stops at the other pane's minimum.
    fireEvent.pointerDown(sep, { pointerId: 2, button: 0, clientX: 800 });
    fireEvent.pointerMove(sep, { pointerId: 2, clientX: 5000 });
    fireEvent.pointerUp(sep, { pointerId: 2 });
    expect(useLayoutStore.getState().panesRatio).toBeCloseTo(
      (total - 280) / total,
      4,
    );
  });

  it("resizes the preview from its left edge and the transfers from their top edge", () => {
    render(<Shell />);
    fireEvent.pointerDown(separator(/preview/i), {
      pointerId: 1,
      button: 0,
      clientX: 1000,
    });
    fireEvent.pointerMove(separator(/preview/i), {
      pointerId: 1,
      clientX: 900,
    });
    fireEvent.pointerUp(separator(/preview/i), { pointerId: 1 });
    expect(useLayoutStore.getState().previewWidth).toBe(440);

    fireEvent.pointerDown(separator(/transfers/i), {
      pointerId: 2,
      button: 0,
      clientY: 700,
    });
    fireEvent.pointerMove(separator(/transfers/i), {
      pointerId: 2,
      clientY: 650,
    });
    fireEvent.pointerUp(separator(/transfers/i), { pointerId: 2 });
    expect(useLayoutStore.getState().transfersHeight).toBe(218);
  });

  it("resizes with the keyboard and resets to the default on double-click", () => {
    resetStore({ sidebarWidth: 400 });
    render(<Shell />);
    const sep = separator(/sidebar/i);
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(useLayoutStore.getState().sidebarWidth).toBe(416);
    fireEvent.keyDown(sep, { key: "ArrowLeft", shiftKey: true });
    expect(useLayoutStore.getState().sidebarWidth).toBe(352);
    fireEvent.keyDown(sep, { key: "Home" });
    expect(useLayoutStore.getState().sidebarWidth).toBe(160);
    fireEvent.doubleClick(sep);
    expect(useLayoutStore.getState().sidebarWidth).toBe(280);

    fireEvent.doubleClick(separator(/preview/i));
    expect(useLayoutStore.getState().previewWidth).toBe(340);
    fireEvent.doubleClick(separator(/transfers/i));
    expect(useLayoutStore.getState().transfersHeight).toBe(168);
    useLayoutStore.getState().setPanesRatio(0.7);
    fireEvent.doubleClick(separator(/local and remote/i));
    expect(useLayoutStore.getState().panesRatio).toBeCloseTo(0.5, 2);
  });

  it("takes no space while the preview is closed and reopens at the stored width", () => {
    resetStore({ previewWidth: 420 });
    render(<Shell />);
    const open = vars();
    act(() => useLayoutStore.getState().setPreviewOpen(false));
    expect(screen.queryByRole("separator", { name: /preview/i })).toBeNull();
    // The preview's width and its gap go back to the panes; with the ratio
    // unchanged, each pane is wider and nothing else moved.
    expect(vars().sidebar).toBe(open.sidebar);
    act(() => useLayoutStore.getState().setPreviewOpen(true));
    expect(separator(/preview/i)).toHaveAttribute("aria-valuenow", "420");
    expect(vars().preview).toBe("420px");
    expect(useLayoutStore.getState().previewWidth).toBe(420);
  });

  it("has no transfers handle while the island is collapsed", () => {
    resetStore({ transfersCollapsed: true });
    render(<Shell />);
    expect(screen.queryByRole("separator", { name: /transfers/i })).toBeNull();
    act(() => useLayoutStore.getState().setTransfersCollapsed(false));
    expect(separator(/transfers/i)).toBeInTheDocument();
  });

  it("re-clamps to the window on resize without changing what is stored", () => {
    resetStore({ previewWidth: 600, transfersHeight: 400, sidebarWidth: 400 });
    render(<Shell />);
    expect(vars().preview).toBe("600px");
    expect(vars().sidebar).toBe("400px");

    setWindow(1000, 500);
    act(() => {
      window.dispatchEvent(new Event("resize"));
      flushFrames();
    });
    const small = vars();
    // Sidebar gives way first, then the preview; panes keep 280 px each.
    expect(small.sidebar).toBe("160px");
    expect(small.preview).toBe("240px");
    expect(small.transfers).toBe(`${Math.floor(500 * 0.6) - 28}px`);
    expect(separator(/local and remote/i)).toHaveAttribute(
      "aria-valuemax",
      "280",
    );
    expect(useLayoutStore.getState().previewWidth).toBe(600);
    expect(useLayoutStore.getState().sidebarWidth).toBe(400);
    expect(useLayoutStore.getState().transfersHeight).toBe(400);

    // Growing the window again brings the chosen sizes back.
    setWindow(1600, 900);
    act(() => {
      window.dispatchEvent(new Event("resize"));
      flushFrames();
    });
    expect(vars().preview).toBe("600px");
    expect(vars().sidebar).toBe("400px");
    expect(vars().transfers).toBe("400px");
  });

  it("holds the preview to half the window", () => {
    resetStore({ previewWidth: 1200 });
    render(<Shell />);
    expect(vars().preview).toBe("800px");
  });
});
