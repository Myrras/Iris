/**
 * Dragging rows from one file pane onto the other (or onto a folder row in
 * it) queues a transfer.
 *
 * Built on mouse events rather than HTML5 drag and drop on purpose: Iris
 * enables Tauri's native drag-drop handler (`dragDropEnabled`) to receive
 * files from Finder / Explorer, and that handler takes over the webview's
 * drop target on every platform — wry's macOS handler answers
 * `draggingEntered`/`performDragOperation` itself, and on Windows it
 * disables HTML5 drag and drop outright — so DOM `dragover`/`drop` events
 * would never arrive. Mouse events are untouched by it.
 *
 * After a mouse-down on a row, moving past `DRAG_THRESHOLD` starts the drag;
 * the window then tracks the pointer (the element under it is the event
 * target, as nothing captures the pointer) and releasing over the other
 * pane starts the transfer. Escape cancels.
 */

import type { Entry } from "../ipc/types";
import { dropTargetAt, useDragStore } from "../state/dragStore";
import { actionTargets, usePaneStore, type PaneId } from "../state/paneStore";
import { startTransfer } from "./transfer";

/** Pixels the pointer must travel before a press becomes a drag. */
export const DRAG_THRESHOLD = 4;

/**
 * Track a possible drag from pane `from` after a primary-button press at
 * (`x`, `y`). `items` is asked once, when the drag really starts (the pane
 * selects the pressed row then, as Finder does).
 */
export function beginPaneDrag(
  from: PaneId,
  x: number,
  y: number,
  items: () => string[],
): void {
  let paths: string[] | null = null;
  const drag = useDragStore.getState;

  const valid = (el: EventTarget | null) => {
    const over = dropTargetAt(el);
    return over && over.pane !== from ? over : null;
  };

  function onMove(e: MouseEvent) {
    if (!paths) {
      if (Math.hypot(e.clientX - x, e.clientY - y) < DRAG_THRESHOLD) return;
      paths = items();
      if (paths.length === 0) {
        stop();
        return;
      }
      drag().startPaneDrag({
        from,
        count: paths.length,
        x: e.clientX,
        y: e.clientY,
      });
      document.body.style.cursor = "copy";
      // Sweeping across the toolbar or breadcrumb must not select text.
      document.body.style.userSelect = "none";
    }
    drag().movePaneDrag(e.clientX, e.clientY, valid(e.target));
  }

  function onUp(e: MouseEvent) {
    const dropped = paths;
    const over = dropped ? valid(e.target) : null;
    stop();
    if (!dropped) return;
    swallowNextClick();
    if (over) void startTransfer(from, dropped, over.dir);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !paths) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  }

  function stop() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    if (paths) {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      drag().end();
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey, true);
}

/**
 * A drag that ends on the row it started on would still "click" it; the
 * click that follows the release belongs to the drag, not to the row.
 */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

/**
 * A press on `entry` in pane `from` may become a drag of the selection — or,
 * when `entry` is not selected, of `entry` alone, which then becomes the
 * selection (Finder).
 */
export function startPaneDrag(
  from: PaneId,
  entry: Entry,
  x: number,
  y: number,
): void {
  beginPaneDrag(from, x, y, () => {
    const panes = usePaneStore.getState();
    if (!panes.panes[from].selection.includes(entry.path)) {
      panes.setSelection(from, {
        selection: [entry.path],
        anchor: entry.path,
        cursor: entry.path,
      });
      return [entry.path];
    }
    return actionTargets(usePaneStore.getState().panes[from]).map(
      (e) => e.path,
    );
  });
}
