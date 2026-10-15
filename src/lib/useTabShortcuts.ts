/**
 * Tab shortcuts, browser style (Cmd on macOS, Ctrl elsewhere): ⌘T new tab,
 * ⌘W close the tab on screen, ⌘1–⌘8 that tab, ⌘9 the last one, ⌘⇧] / ⌘⇧[
 * the next / previous one. Iris's macOS menu has no Close Window item, so
 * ⌘W reaches the webview. Ignored while typing in a field; none of these
 * clash with the pane shortcuts (`Pane.tsx`).
 */

import { useEffect } from "react";

import { useTabsStore } from "../state/tabsStore";
import { isMac } from "./platform";
import { requestCloseActiveTab } from "./tabs";

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

export function useTabShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.defaultPrevented || isEditable(e.target)) {
        return;
      }
      const tabs = useTabsStore.getState();
      const key = e.key.toLowerCase();
      let handled = true;
      if (e.shiftKey && e.code === "BracketRight") tabs.cycle(1);
      else if (e.shiftKey && e.code === "BracketLeft") tabs.cycle(-1);
      else if (e.shiftKey) handled = false;
      else if (key === "t") tabs.newTab();
      else if (key === "w") requestCloseActiveTab();
      else if (/^[1-8]$/.test(e.key)) tabs.switchToIndex(Number(e.key) - 1);
      else if (e.key === "9") tabs.switchToIndex(-1);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
