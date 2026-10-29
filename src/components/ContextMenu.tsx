/**
 * A small cursor-positioned context menu (backdrop + menu card), animated in
 * and out via `usePresence` + `data-state`. Copied from Selene's ContextMenu
 * without its flyout submenus (nothing in Iris needs them yet).
 *
 * A `header` entry starts a group: it is a caption, not a menu item, so it is
 * out of the tab order and out of the accessibility tree.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";

import { MOTION, usePresence } from "../lib/motion";
import styles from "./ContextMenu.module.css";

export interface ContextMenuItem {
  kind?: "item";
  label: string;
  onSelect: () => void;
  /** Its keyboard shortcut, shown at the right edge (`⌘R`). */
  shortcut?: string;
  disabled?: boolean;
  /** Paint the item in the danger tone (delete). */
  danger?: boolean;
}

/** A caption above the items that follow it. */
export interface ContextMenuHeader {
  kind: "header";
  label: string;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuHeader;

export function ContextMenu({
  open,
  x,
  y,
  items,
  onClose,
}: {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}) {
  // Keep mounted across the (fast) exit animation.
  const { mounted, state } = usePresence(open, MOTION.fast);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  // Portal to <body> so an island's `overflow: hidden` / transform cannot clip
  // or re-anchor the fixed-position menu.
  return createPortal(
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className={styles.menu}
        data-state={state}
        role="menu"
        style={{ left: x, top: y }}
        // Don't let a click inside the menu hit the backdrop's dismiss.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Keyed by index: labels repeat once the menu has groups. */}
        {items.map((item, i) =>
          item.kind === "header" ? (
            <div key={i} className={styles.header} role="presentation">
              {item.label}
            </div>
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={styles.item}
              data-danger={item.danger ? "true" : undefined}
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              {item.label}
              {item.shortcut && (
                <span className={styles.shortcut} aria-hidden="true">
                  {item.shortcut}
                </span>
              )}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
