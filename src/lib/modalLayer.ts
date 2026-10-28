/**
 * Which `Modal` is on top.
 *
 * Every open dialog is its own full-screen overlay portalled to <body>, so two
 * of them at once (a host key question over a busy password prompt, a transfer
 * conflict over Sync, the same dialog opened from both panes) paint their
 * cards on top of each other: two Cancel buttons at different offsets, one
 * clipped under the other. The newest open dialog owns the screen; `Modal`
 * hides the others (they stay mounted, so their state survives) and only the
 * top one answers Escape.
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

/** Open dialogs in the order they opened; the last one is on top. */
const stack: number[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  listeners.forEach((l) => l());
}

/** The id of the dialog on top, 0 when none is open. */
function topId() {
  return stack.length > 0 ? stack[stack.length - 1] : 0;
}

export interface ModalLayer {
  /**
   * Another dialog is on top: hide this one. Also true for a dialog still
   * animating out while another one is open, so the two never cross-fade on
   * top of each other.
   */
  covered: boolean;
  /** Whether this dialog is the one on top right now (read at event time). */
  isTop: () => boolean;
}

export function useModalLayer(open: boolean): ModalLayer {
  const id = useRef(0);
  if (id.current === 0) id.current = nextId++;

  // Layout effect: the new dialog takes the top before the first paint, so it
  // never shows up covered for a frame.
  useLayoutEffect(() => {
    if (!open) return;
    const mine = id.current;
    stack.push(mine);
    emit();
    return () => {
      const at = stack.indexOf(mine);
      if (at !== -1) stack.splice(at, 1);
      emit();
    };
  }, [open]);

  const top = useSyncExternalStore(subscribe, topId, topId);
  // Stable: it sits in an effect's dependencies.
  const isTop = useCallback(() => topId() === id.current, []);
  return { covered: open ? top !== id.current : top !== 0, isTop };
}
