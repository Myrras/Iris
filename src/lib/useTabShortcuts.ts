/**
 * The window-wide shortcuts, from the keymap (`lib/keymap`; rebindable in
 * Settings → Shortcuts): new tab, close tab, next / previous tab — all on
 * the ACTIVE pane's folder tabs (`paneStore.active`) — and Settings off
 * macOS (macOS has the native menu's ⌘,). ⌘1–⌘8 switch to that tab of the
 * active pane and ⌘9 to its last one, fixed. Iris's macOS menu has no Close
 * Window item, so ⌘W reaches the webview. Ignored while typing in a field.
 *
 * It also swallows the browser's own shortcuts (reload, print, find, save):
 * a desktop app must never reload its webview, wherever the focus is.
 */

import { useEffect } from "react";

import { usePaneStore } from "../state/paneStore";
import { tabSetOf, useTabsStore } from "../state/tabsStore";
import {
  findAction,
  isBrowserShortcut,
  isEditableTarget,
  type KeyEventLike,
} from "./keymap";
import { isMac } from "./platform";
import { currentKeymap } from "./useKeymap";

/** ⌘1–⌘8 / ⌘9 (Ctrl elsewhere), no other modifier. */
function tabNumber(e: KeyEventLike): string | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const stray = isMac ? e.ctrlKey : e.metaKey;
  if (!mod || stray || e.altKey || e.shiftKey) return null;
  return /^[1-9]$/.test(e.key) ? e.key : null;
}

export function useTabShortcuts(options?: { onOpenSettings?: () => void }) {
  const onOpenSettings = options?.onOpenSettings;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = findAction(e, currentKeymap(), "app");
      // Settings opens from a field too, as the native ⌘, does.
      const typing = isEditableTarget(e.target) && action !== "openSettings";
      if (!e.defaultPrevented && !typing) {
        const tabs = useTabsStore.getState();
        const pane = usePaneStore.getState().active;
        const digit = tabNumber(e);
        let handled = true;
        if (action === "newTab") tabs.newTab(pane);
        else if (action === "closeTab") {
          const id = tabSetOf(tabs, pane)?.activeTabId;
          if (id) tabs.closeTab(pane, id);
        } else if (action === "nextTab") tabs.cycleTab(pane, 1);
        else if (action === "prevTab") tabs.cycleTab(pane, -1);
        else if (action === "openSettings" && onOpenSettings) onOpenSettings();
        else if (digit === "9") tabs.switchTabIndex(pane, -1);
        else if (digit) tabs.switchTabIndex(pane, Number(digit) - 1);
        else handled = false;
        if (handled) {
          e.preventDefault();
          return;
        }
      }
      if (isBrowserShortcut(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenSettings]);
}
