import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubPointerEvents } from "../test/pointer";
import { Splitter, type SplitterProps } from "./Splitter";

/** Frames run only when the test says so. */
let frames: FrameRequestCallback[] = [];
function flushFrames() {
  const run = frames;
  frames = [];
  run.forEach((cb) => cb(0));
}

beforeEach(() => {
  frames = [];
  stubPointerEvents();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});

afterEach(() => vi.unstubAllGlobals());

function setup(props: Partial<SplitterProps> = {}) {
  const onResize = vi.fn();
  const onCommit = vi.fn();
  const view = render(
    <Splitter
      orientation="vertical"
      label="Resize thing"
      value={300}
      min={100}
      max={500}
      defaultValue={250}
      onResize={onResize}
      onCommit={onCommit}
      {...props}
    />,
  );
  return {
    onResize,
    onCommit,
    view,
    sep: screen.queryByRole("separator") as HTMLElement,
  };
}

const html = document.documentElement;

describe("Splitter", () => {
  it("is a focusable separator with its range", () => {
    const { sep } = setup();
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("aria-valuenow", "300");
    expect(sep).toHaveAttribute("aria-valuemin", "100");
    expect(sep).toHaveAttribute("aria-valuemax", "500");
    expect(sep).toHaveAttribute("aria-label", "Resize thing");
    expect(sep).toHaveAttribute("tabindex", "0");
  });

  it("drags: previews once per frame, saves on release, locks selection meanwhile", () => {
    const { sep, onResize, onCommit } = setup();
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX: 100 });
    expect(html.dataset.resizing).toBe("col");
    expect(sep).toHaveAttribute("data-active", "true");

    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 120 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 150 });
    expect(onResize).not.toHaveBeenCalled();
    flushFrames();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith(350);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 150 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(350);
    expect(html.dataset.resizing).toBeUndefined();
    expect(sep).not.toHaveAttribute("data-active");
  });

  it("clamps a drag to the limits", () => {
    const { sep, onCommit } = setup();
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 5000 });
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(onCommit).toHaveBeenLastCalledWith(500);
    fireEvent.pointerDown(sep, { pointerId: 2, button: 0, clientX: 100 });
    fireEvent.pointerMove(sep, { pointerId: 2, clientX: -5000 });
    fireEvent.pointerUp(sep, { pointerId: 2 });
    expect(onCommit).toHaveBeenLastCalledWith(100);
  });

  it("grows an inverted splitter when the handle moves toward the start, and uses Y when horizontal", () => {
    const { sep, onCommit } = setup({
      orientation: "horizontal",
      invert: true,
    });
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientY: 400 });
    expect(html.dataset.resizing).toBe("row");
    fireEvent.pointerMove(sep, { pointerId: 1, clientY: 350 });
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(350);
  });

  it("saves nothing for a click without movement, nor for other buttons or pointers", () => {
    const { sep, onCommit } = setup();
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 100 });
    fireEvent.pointerDown(sep, { pointerId: 2, button: 2, clientX: 100 });
    expect(html.dataset.resizing).toBeUndefined();
    fireEvent.pointerDown(sep, { pointerId: 3, button: 0, clientX: 100 });
    fireEvent.pointerMove(sep, { pointerId: 9, clientX: 200 });
    fireEvent.pointerUp(sep, { pointerId: 9 });
    expect(html.dataset.resizing).toBe("col");
    fireEvent.pointerUp(sep, { pointerId: 3 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("cancels a drag with Escape: back to the start, nothing saved", () => {
    const { sep, onResize, onCommit } = setup();
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 180 });
    fireEvent.keyDown(sep, { key: "Escape" });
    expect(onResize).toHaveBeenLastCalledWith(300);
    expect(html.dataset.resizing).toBeUndefined();
    fireEvent.pointerUp(sep, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("resizes with the arrows (16 px, Shift 64 px) and Home/End", () => {
    const { sep, onCommit } = setup();
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(onCommit).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenLastCalledWith(284);
    fireEvent.keyDown(sep, { key: "ArrowRight", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(364);
    fireEvent.keyDown(sep, { key: "ArrowLeft", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(236);
    fireEvent.keyDown(sep, { key: "Home" });
    expect(onCommit).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(sep, { key: "End" });
    expect(onCommit).toHaveBeenLastCalledWith(500);
    expect(onCommit).toHaveBeenCalledTimes(6);
  });

  it("ignores other keys and the wrong axis, and does not repeat a size it already has", () => {
    const { sep, onCommit } = setup({ value: 500 });
    fireEvent.keyDown(sep, { key: "ArrowUp" });
    fireEvent.keyDown(sep, { key: "a" });
    fireEvent.keyDown(sep, { key: "ArrowRight", metaKey: true });
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("follows the handle with the arrows when inverted", () => {
    const { sep, onCommit } = setup({
      orientation: "horizontal",
      invert: true,
    });
    fireEvent.keyDown(sep, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(sep, { key: "ArrowDown", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(236);
  });

  it("resets to the default on double-click, within the limits", () => {
    const { sep, onCommit } = setup();
    fireEvent.doubleClick(sep);
    expect(onCommit).toHaveBeenCalledWith(250);
  });

  it("clamps the default into the limits", () => {
    const { sep, onCommit } = setup({ defaultValue: 900 });
    fireEvent.doubleClick(sep);
    expect(onCommit).toHaveBeenCalledWith(500);
  });

  it("is only a gap when disabled", () => {
    setup({ disabled: true });
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("does not leave the page locked when it unmounts mid-drag", () => {
    const { sep, view } = setup();
    fireEvent.pointerDown(sep, { pointerId: 1, button: 0, clientX: 100 });
    expect(html.dataset.resizing).toBe("col");
    view.unmount();
    expect(html.dataset.resizing).toBeUndefined();
  });
});
