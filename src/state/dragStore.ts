/**
 * Drag and drop in flight: rows dragged from one pane to the other
 * (`lib/paneDrag`), or files dragged in from Finder / Explorer
 * (`lib/useNativeDrop`). Panes and rows read `over` to highlight the drop
 * target; `DragGhost` follows the pointer during a pane drag.
 */

import { create } from "zustand";

import type { PaneId } from "./paneStore";

/** Where a drop would land: a pane's folder, or a folder row in it. */
export interface DropTarget {
  pane: PaneId;
  /** A folder row under the pointer; `null` = the pane's current folder. */
  dir: string | null;
}

export interface PaneDrag {
  from: PaneId;
  count: number;
  /** Pointer position (client coordinates). */
  x: number;
  y: number;
}

interface DragState {
  paneDrag: PaneDrag | null;
  /** Files from the OS hover the window. */
  nativeDrag: boolean;
  /** The valid drop target under the pointer, if any. */
  over: DropTarget | null;
  startPaneDrag: (drag: PaneDrag) => void;
  movePaneDrag: (x: number, y: number, over: DropTarget | null) => void;
  setNative: (active: boolean, over: DropTarget | null) => void;
  end: () => void;
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a === b || (!!a && !!b && a.pane === b.pane && a.dir === b.dir);

export const useDragStore = create<DragState>((set, get) => ({
  paneDrag: null,
  nativeDrag: false,
  over: null,
  startPaneDrag: (drag) => set({ paneDrag: drag, over: null }),
  movePaneDrag: (x, y, over) => {
    const drag = get().paneDrag;
    if (!drag) return;
    set({
      paneDrag: { ...drag, x, y },
      // Keep the same object while the target holds, so rows do not re-render.
      over: sameTarget(get().over, over) ? get().over : over,
    });
  },
  setNative: (active, over) =>
    set({
      nativeDrag: active,
      over: sameTarget(get().over, over) ? get().over : over,
    }),
  end: () => set({ paneDrag: null, nativeDrag: false, over: null }),
}));

/**
 * The drop target under `el`: the pane (`data-drop-pane`) holding it and the
 * folder row (`data-drop-dir`) it is on, if any.
 */
export function dropTargetAt(el: EventTarget | null): DropTarget | null {
  if (!(el instanceof Element)) return null;
  const paneEl = el.closest<HTMLElement>("[data-drop-pane]");
  const pane = paneEl?.dataset.dropPane;
  if (pane !== "local" && pane !== "remote") return null;
  const dirEl = el.closest<HTMLElement>("[data-drop-dir]");
  return {
    pane,
    dir:
      dirEl && paneEl?.contains(dirEl) ? (dirEl.dataset.dropDir ?? null) : null,
  };
}
