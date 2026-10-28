/**
 * The drag handle between two islands. It sits in the canvas gap
 * (`--gap-island`), shows an accent line on hover, focus and while dragging,
 * and resizes one neighbouring island:
 *
 * - Pointer: mouse/pointer events with pointer capture (not HTML5 DnD, which
 *   Tauri's `dragDropEnabled` takes over). While the button is down the
 *   attribute `data-resizing` is on `<html>` (no text selection, no stuck
 *   hover, fixed cursor). `onResize` fires at most once per animation frame so
 *   the caller can move CSS variables without touching React or the store;
 *   `onCommit` fires once on release with the final size.
 * - Keyboard: focusable `separator`; arrows move the handle by 16 px, Shift
 *   by 64 px, Home/End jump to the minimum/maximum (`lib/resize`).
 * - Double-click resets to `defaultValue`.
 *
 * `value`, `min`, `max` and `defaultValue` are the size (px) of the island
 * being resized. `invert` is for a handle that sits on the island's start
 * side (the preview's left edge, the transfers' top edge): moving it toward
 * the window's start grows the island.
 *
 * Disabled, it is only the gap: nothing to resize (collapsed island).
 */

import { useEffect, useRef } from "react";

import { clamp, keyboardTarget, type Orientation } from "../lib/resize";
import styles from "./Splitter.module.css";

export interface SplitterProps {
  /** ARIA orientation of the separator: vertical = a vertical line, resizes widths. */
  orientation: Orientation;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  invert?: boolean;
  label: string;
  disabled?: boolean;
  /** During a drag, once per frame, with the clamped size. */
  onResize?: (size: number) => void;
  /** The final size: pointer release, key press or reset. */
  onCommit: (size: number) => void;
}

interface Drag {
  pointerId: number;
  startPos: number;
  startValue: number;
  latest: number;
  frame: number | null;
}

const RESIZING = "resizing";

export function Splitter({
  orientation,
  value,
  min,
  max,
  defaultValue,
  invert = false,
  label,
  disabled = false,
  onResize,
  onCommit,
}: SplitterProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const finish = () => {
    const d = drag.current;
    if (!d) return null;
    drag.current = null;
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    delete document.documentElement.dataset[RESIZING];
    ref.current?.removeAttribute("data-active");
    try {
      ref.current?.releasePointerCapture?.(d.pointerId);
    } catch {
      /* the capture is already gone */
    }
    return d;
  };

  // An unmount mid-drag (the island collapsed) must not leave the page locked.
  useEffect(() => () => void finish(), []);

  if (disabled) {
    return <div className={styles.gap} data-orientation={orientation} />;
  }

  const position = (e: React.PointerEvent) =>
    orientation === "vertical" ? e.clientX : e.clientY;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    drag.current = {
      pointerId: e.pointerId,
      startPos: position(e),
      startValue: value,
      latest: value,
      frame: null,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.setAttribute("data-active", "true");
    document.documentElement.dataset[RESIZING] =
      orientation === "vertical" ? "col" : "row";
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const delta = position(e) - d.startPos;
    d.latest = clamp(d.startValue + (invert ? -delta : delta), min, max);
    if (d.frame === null) {
      d.frame = requestAnimationFrame(() => {
        d.frame = null;
        onResize?.(d.latest);
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    const d = finish();
    if (d && d.latest !== d.startValue) onCommit(d.latest);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (e.key === "Escape" && d) {
      // Cancel the drag: back to where it started, nothing saved.
      e.preventDefault();
      finish();
      onResize?.(d.startValue);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = keyboardTarget(
      e.key,
      e.shiftKey,
      value,
      min,
      max,
      orientation,
      invert,
    );
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onCommit(next);
  };

  return (
    <div
      ref={ref}
      className={styles.splitter}
      data-orientation={orientation}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(clamp(defaultValue, min, max))}
    />
  );
}
