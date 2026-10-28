import { useRef } from "react";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/**
 * Finder: using the keyboard hides the hover highlight until the pointer
 * moves again. One `data-keyboard` attribute on the element carrying the
 * handlers (no state, no re-render); CSS does the rest.
 *
 * A mousemove only counts when the coordinates changed: WebKit also fires
 * one when content scrolls under a still pointer (the cursor row scrolled
 * into view). The first move only records a position.
 */
export function useKeyboardMode() {
  const last = useRef<{ x: number; y: number } | null>(null);
  return {
    onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
      // A held modifier alone is not keyboard use (⌘-click, ⇧-click).
      if (MODIFIER_KEYS.has(e.key)) return;
      e.currentTarget.dataset.keyboard = "true";
    },
    onMouseMove(e: React.MouseEvent<HTMLElement>) {
      const prev = last.current;
      last.current = { x: e.clientX, y: e.clientY };
      if (prev && (prev.x !== e.clientX || prev.y !== e.clientY))
        delete e.currentTarget.dataset.keyboard;
    },
  };
}
