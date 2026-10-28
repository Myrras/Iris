import { describe, expect, it } from "vitest";

import {
  GAP_PX,
  PANE_MIN_PX,
  PREVIEW_MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
  TRANSFERS_HEADER_PX,
  TRANSFERS_MIN_HEIGHT,
  clamp,
  keyboardTarget,
  layoutVars,
  resolveLayout,
  type LayoutPrefs,
} from "./resize";

const PREFS: LayoutPrefs = {
  sidebarWidth: 280,
  panesRatio: 0.5,
  previewWidth: 340,
  previewOpen: true,
  transfersHeight: 168,
  transfersCollapsed: false,
};
const BIG = { width: 1600, height: 900 };

describe("clamp", () => {
  it("keeps a value inside its range, the minimum winning when it is empty", () => {
    expect(clamp(5, 10, 20)).toBe(10);
    expect(clamp(25, 10, 20)).toBe(20);
    expect(clamp(15, 10, 20)).toBe(15);
    expect(clamp(15, 30, 20)).toBe(30);
  });
});

describe("keyboardTarget", () => {
  it("steps 16 px with the arrows and 64 px with Shift", () => {
    expect(keyboardTarget("ArrowRight", false, 300, 100, 600, "vertical")).toBe(
      316,
    );
    expect(keyboardTarget("ArrowLeft", false, 300, 100, 600, "vertical")).toBe(
      284,
    );
    expect(keyboardTarget("ArrowRight", true, 300, 100, 600, "vertical")).toBe(
      364,
    );
    expect(keyboardTarget("ArrowLeft", true, 300, 100, 600, "vertical")).toBe(
      236,
    );
  });

  it("answers the axis of the separator only", () => {
    expect(keyboardTarget("ArrowUp", false, 300, 100, 600, "vertical")).toBe(
      null,
    );
    expect(
      keyboardTarget("ArrowRight", false, 300, 100, 600, "horizontal"),
    ).toBe(null);
    expect(
      keyboardTarget("ArrowDown", false, 300, 100, 600, "horizontal"),
    ).toBe(316);
    expect(keyboardTarget("a", false, 300, 100, 600, "vertical")).toBe(null);
  });

  it("moves the handle, so an inverted size shrinks when the handle goes toward the end", () => {
    expect(
      keyboardTarget("ArrowRight", false, 300, 100, 600, "vertical", true),
    ).toBe(284);
    expect(
      keyboardTarget("ArrowLeft", false, 300, 100, 600, "vertical", true),
    ).toBe(316);
    expect(
      keyboardTarget("ArrowUp", true, 300, 100, 600, "horizontal", true),
    ).toBe(364);
  });

  it("jumps to the minimum and maximum with Home and End, and never leaves them", () => {
    expect(keyboardTarget("Home", false, 300, 100, 600, "vertical")).toBe(100);
    expect(keyboardTarget("End", false, 300, 100, 600, "vertical", true)).toBe(
      600,
    );
    expect(keyboardTarget("ArrowRight", true, 580, 100, 600, "vertical")).toBe(
      600,
    );
    expect(keyboardTarget("ArrowLeft", true, 120, 100, 600, "vertical")).toBe(
      100,
    );
  });
});

describe("resolveLayout", () => {
  it("shows the stored sizes when the window is big enough", () => {
    const l = resolveLayout(PREFS, BIG);
    expect(l.sidebar).toBe(280);
    expect(l.preview).toBe(340);
    expect(l.transfers).toBe(168);
    // 1600 - 5 gaps (padding x2, sidebar, panes, preview) - 280 - 340
    const total = 1600 - 5 * GAP_PX - 280 - 340;
    expect(l.panesTotal).toBe(total);
    expect(l.local + l.remote).toBe(total);
    expect(l.local).toBe(Math.round(total / 2));
  });

  it("splits the panes by the ratio and keeps each at least the minimum", () => {
    const wide = resolveLayout({ ...PREFS, panesRatio: 0.7 }, BIG);
    expect(wide.local).toBe(Math.round(wide.panesTotal * 0.7));
    const lo = resolveLayout({ ...PREFS, panesRatio: 0.05 }, BIG);
    expect(lo.local).toBe(PANE_MIN_PX);
    const hi = resolveLayout({ ...PREFS, panesRatio: 0.95 }, BIG);
    expect(hi.remote).toBe(PANE_MIN_PX);
    expect(hi.limits.local).toEqual({
      min: PANE_MIN_PX,
      max: hi.panesTotal - PANE_MIN_PX,
    });
  });

  it("limits the preview to half the window and a minimum width", () => {
    const l = resolveLayout({ ...PREFS, previewWidth: 5000 }, BIG);
    expect(l.preview).toBe(800);
    expect(l.limits.preview.max).toBe(800);
    expect(resolveLayout({ ...PREFS, previewWidth: 10 }, BIG).preview).toBe(
      PREVIEW_MIN_WIDTH,
    );
  });

  it("takes no space while the preview is closed but remembers its width", () => {
    const open = resolveLayout(PREFS, BIG);
    const closed = resolveLayout({ ...PREFS, previewOpen: false }, BIG);
    expect(closed.preview).toBe(0);
    expect(closed.previewWidth).toBe(340);
    // The preview and its splitter's gap go to the panes.
    expect(closed.panesTotal).toBe(open.panesTotal + 340 + GAP_PX);
  });

  it("squeezes the sidebar first, then the preview, and never the panes", () => {
    // 1100 wide: panes 560 + gaps 40 + preview 340 leave 160 for the sidebar.
    const mid = resolveLayout(PREFS, { width: 1100, height: 720 });
    expect(mid.sidebar).toBe(SIDEBAR_MIN_WIDTH);
    expect(mid.preview).toBe(340);
    expect(mid.local).toBeGreaterThanOrEqual(PANE_MIN_PX);
    expect(mid.remote).toBeGreaterThanOrEqual(PANE_MIN_PX);
    // Narrower: the preview gives way too, down to its minimum.
    const small = resolveLayout(PREFS, { width: 1000, height: 720 });
    expect(small.sidebar).toBe(SIDEBAR_MIN_WIDTH);
    expect(small.preview).toBe(PREVIEW_MIN_WIDTH);
    expect(small.local).toBe(PANE_MIN_PX);
    expect(small.remote).toBe(PANE_MIN_PX);
  });

  it("lets a wide preview push the sidebar to its minimum but not the panes", () => {
    const l = resolveLayout({ ...PREFS, previewWidth: 800 }, BIG);
    expect(l.preview).toBe(800);
    expect(l.sidebar).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
    expect(l.local).toBeGreaterThanOrEqual(PANE_MIN_PX);
    expect(l.remote).toBeGreaterThanOrEqual(PANE_MIN_PX);
    expect(l.limits.preview.max).toBe(
      Math.min(800, 1600 - 5 * GAP_PX - 2 * PANE_MIN_PX - SIDEBAR_MIN_WIDTH),
    );
  });

  it("keeps the transfer list between two rows and 60% of the window (header included)", () => {
    const tall = resolveLayout({ ...PREFS, transfersHeight: 5000 }, BIG);
    expect(tall.transfers).toBe(540 - TRANSFERS_HEADER_PX);
    expect(tall.limits.transfers.max).toBe(540 - TRANSFERS_HEADER_PX);
    expect(resolveLayout({ ...PREFS, transfersHeight: 1 }, BIG).transfers).toBe(
      TRANSFERS_MIN_HEIGHT,
    );
    // A tiny window: the minimum wins.
    expect(
      resolveLayout(PREFS, { width: 1600, height: 80 }).limits.transfers.max,
    ).toBe(TRANSFERS_MIN_HEIGHT);
  });
});

describe("layoutVars", () => {
  it("writes px sizes and whole-number pane weights adding up to 1000", () => {
    const vars = layoutVars(
      resolveLayout({ ...PREFS, previewOpen: false }, BIG),
    );
    expect(vars["--sidebar-w"]).toBe("280px");
    expect(vars["--preview-w"]).toBe("340px");
    expect(vars["--transfers-list-h"]).toBe("168px");
    expect(
      Number(vars["--pane-local-grow"]) + Number(vars["--pane-remote-grow"]),
    ).toBe(1000);
  });
});
