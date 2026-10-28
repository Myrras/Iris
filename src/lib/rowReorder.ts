/**
 * Dragging a connection row up or down the sidebar to reorder it.
 *
 * Like `lib/paneDrag` this is built on mouse events, not HTML5 drag and drop
 * (Tauri's native drag-drop handler owns the webview's drop target, so DOM
 * `dragover` / `drop` would never arrive). After a press, moving past
 * `DRAG_THRESHOLD` starts the drag; the window then tracks the pointer, the
 * insertion line follows it, the list scrolls when the pointer nears the
 * edge of its scroll area, releasing drops and Escape cancels.
 *
 * While it runs `html[data-dragging="reorder"]` is set: the global rules
 * behind `data-dragging` (no text selection, no sticky `:hover`, see
 * `styles/global.css` and the row styles) apply to it as to a pane drag. A
 * pane drag starts from a press in a pane and this one from a press in the
 * sidebar, so the two never overlap.
 *
 * The order rules are pure functions so they are tested without a DOM.
 */

import { DRAG_THRESHOLD, swallowNextClick } from "./paneDrag";

/** Distance from the scroll area's edge where auto-scroll starts. */
export const EDGE_SCROLL_PX = 28;
/** Pixels scrolled per frame at the very edge (or beyond it). */
export const MAX_SCROLL_STEP = 14;

/**
 * Where a dragged row would be inserted: 0..n, the index of the row it goes
 * before (n = after the last), counted in the list *with* the dragged row.
 * `mids` are the vertical centres of the rows, top to bottom.
 */
export function insertionIndex(mids: number[], y: number): number {
  return mids.filter((mid) => mid < y).length;
}

/**
 * The insertion that actually changes the order, or null: dropping a row
 * right before or after itself leaves everything where it is.
 */
export function effectiveInsert(from: number, insert: number): number | null {
  return insert === from || insert === from + 1 ? null : insert;
}

/** `ids` with the item at `from` moved to the insertion point `insert`. */
export function moveToInsertion<T>(
  ids: readonly T[],
  from: number,
  insert: number,
): T[] {
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(insert > from ? insert - 1 : insert, 0, item);
  return next;
}

/** `ids` with `id` moved one step, or null at the first / last place. */
export function moveBy<T>(ids: readonly T[], id: T, delta: -1 | 1): T[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * How far to scroll this frame for a pointer at `y` over a scroll area
 * spanning `top`..`bottom`: nothing in the middle, faster the closer to (or
 * beyond) an edge. Negative = up.
 */
export function edgeScrollDelta(
  y: number,
  top: number,
  bottom: number,
  edge: number = EDGE_SCROLL_PX,
  max: number = MAX_SCROLL_STEP,
): number {
  if (y < top + edge) {
    return -Math.ceil(max * Math.min(1, (top + edge - y) / edge));
  }
  if (y > bottom - edge) {
    return Math.ceil(max * Math.min(1, (y - (bottom - edge)) / edge));
  }
  return 0;
}

/** The nearest ancestor that scrolls vertically, if any. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === "auto" || overflow === "scroll") return p;
  }
  return null;
}

export interface RowReorderOptions {
  /** Pointer position of the press (client coordinates). */
  x: number;
  y: number;
  /** Index of the pressed row. */
  from: number;
  /** The list element whose children are the rows. */
  list: () => HTMLElement | null;
  /** The press became a drag. */
  onStart: () => void;
  /** The insertion line moved (null = nowhere that changes the order). */
  onInsert: (insert: number | null) => void;
  /** Released over an insertion point that changes the order. */
  onDrop: (insert: number) => void;
  /** The drag is over, however it ended; clear any drag state. */
  onEnd: () => void;
}

/**
 * Track a possible drag after a primary-button press. Returns a function
 * that cancels it (for an unmount mid-drag). A press that never moves past
 * the threshold is no drag at all: nothing is shown and the click goes
 * through to the row as usual.
 */
export function beginRowReorder(o: RowReorderOptions): () => void {
  let active = false;
  let stopped = false;
  let insert: number | null = null;
  let lastY = o.y;
  let frame = 0;
  let scroller: HTMLElement | null = null;
  const html = document.documentElement;

  function locate() {
    const rows = Array.from(o.list()?.children ?? []);
    const mids = rows.map((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    const next = effectiveInsert(o.from, insertionIndex(mids, lastY));
    if (next !== insert) {
      insert = next;
      o.onInsert(next);
    }
  }

  function tick() {
    frame = 0;
    if (!active || stopped) return;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const delta = edgeScrollDelta(lastY, box.top, box.bottom);
      if (delta !== 0) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + delta;
        // The rows moved under a still pointer.
        if (scroller.scrollTop !== before) locate();
      }
    }
    frame = requestAnimationFrame(tick);
  }

  function onMove(e: MouseEvent) {
    lastY = e.clientY;
    if (!active) {
      if (Math.hypot(e.clientX - o.x, e.clientY - o.y) < DRAG_THRESHOLD) return;
      active = true;
      html.dataset.dragging = "reorder";
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
      scroller = scrollParent(o.list());
      o.onStart();
      frame = requestAnimationFrame(tick);
    }
    locate();
  }

  function onUp() {
    const dropped = active;
    const target = insert;
    stop();
    if (!dropped) return;
    // The click that follows the release belongs to the drag, not the row.
    swallowNextClick();
    if (target !== null) o.onDrop(target);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !active) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
    // The button is still down: its release would click the row (connect).
    window.addEventListener("mouseup", swallowNextClick, {
      capture: true,
      once: true,
    });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    if (frame) cancelAnimationFrame(frame);
    if (active) {
      // Only our own mark: a pane drag sets its own.
      if (html.dataset.dragging === "reorder") delete html.dataset.dragging;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      o.onEnd();
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey, true);
  return stop;
}
