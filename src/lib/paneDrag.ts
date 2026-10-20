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
 *
 * Leaving the window turns it into a drag out to Finder / Explorer
 * (`lib/dragOut`): local rows hand over to the OS drag at once; remote rows
 * are downloaded first, the in-window drag keeps tracking meanwhile (the
 * pointer may come back and drop on the Local pane), and the OS drag starts
 * on the first move outside the window once the files are there.
 */

import type { Entry } from "../ipc/types";
import { dropTargetAt, useDragStore } from "../state/dragStore";
import { actionTargets, usePaneStore, type PaneId } from "../state/paneStore";
import {
  finishRemoteDragOut,
  offerDownloadTo,
  prepareRemoteDragOut,
  startNativeDrag,
  type RemotePrep,
} from "./dragOut";
import { remoteSessionId, startTransfer } from "./transfer";

/** Pixels the pointer must travel before a press becomes a drag. */
export const DRAG_THRESHOLD = 4;

/** Whether a pointer at (`x`, `y`) is outside the window's viewport. */
export function outsideWindow(x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
}

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
  let active = true;
  /** The pointer is outside the window. */
  let outside = false;
  /** The primary button is held, as the last move reported it. */
  let held = true;
  /** Remote rows being downloaded for a drag out, and the result. */
  let prep: RemotePrep | null = null;
  let ready: string[] | null = null;
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
      document.documentElement.dataset.dragging = "true";
      window.getSelection()?.removeAllRanges();
    }
    held = (e.buttons & 1) === 1;
    const out = outsideWindow(e.clientX, e.clientY);
    drag().movePaneDrag(
      e.clientX,
      e.clientY,
      out ? null : valid(e.target),
      out,
    );
    if (out) leftWindow();
    else outside = false;
  }

  /** Moving the pointer off the window (`mouseout` with nowhere to go). */
  function onOut(e: MouseEvent) {
    if (paths && e.relatedTarget === null) leftWindow();
  }

  function leftWindow() {
    if (!paths || !active) return;
    outside = true;
    if (from === "local") {
      handOver(paths, null);
    } else if (ready) {
      if (held) handOver(ready, prep);
    } else if (!prep) {
      const sessionId = remoteSessionId();
      if (!sessionId) return;
      const started = prepareRemoteDragOut(sessionId, paths);
      prep = started;
      drag().setPreparing({ bytesDone: 0, totalBytes: 0 });
      void started.done.then((local) => {
        if (!active || prep !== started) return;
        if (!local) {
          // Failed, too large or too slow (already reported): the drag
          // cannot leave the window.
          prep = null;
          stop();
          return;
        }
        ready = local;
        drag().setPreparing(null);
        if (outside && held) handOver(local, started);
      });
    }
  }

  /** End the in-window drag and give `local` to the OS drag. */
  function handOver(local: string[], remote: RemotePrep | null) {
    // The OS drag owns the pointer from now on; the webview gets no
    // mouse-up for this press.
    prep = null;
    stop();
    void startNativeDrag(from, local).then((dropped) => {
      if (remote) finishRemoteDragOut(remote.id, dropped);
    });
  }

  function onUp(e: MouseEvent) {
    const dropped = paths;
    const out = outside || outsideWindow(e.clientX, e.clientY);
    const over = dropped && !out ? valid(e.target) : null;
    const preparing = prep !== null && ready === null;
    stop();
    if (!dropped) return;
    swallowNextClick();
    if (over) void startTransfer(from, dropped, over.dir);
    else if (out && preparing) {
      offerDownloadTo(dropped, "Released before the files were ready");
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !paths) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  }

  function stop() {
    if (!active) return;
    active = false;
    // A drag out that never left the window throws its files away.
    prep?.cancel();
    prep = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("mouseout", onOut);
    window.removeEventListener("keydown", onKey, true);
    if (paths) {
      delete document.documentElement.dataset.dragging;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      drag().end();
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("mouseout", onOut);
  window.addEventListener("keydown", onKey, true);
}

/**
 * A drag that ends on the row it started on would still "click" it; the
 * click that follows the release belongs to the drag, not to the row.
 */
export function swallowNextClick() {
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
