/**
 * A pane's folder tabs (Selene's tab strip, scaled into the pane header):
 * one chip per tab named after its folder, with the full path as tooltip.
 * `+` opens a tab on the folder shown, middle-click or × closes one; a pane
 * always keeps one tab, so a lone tab has no close button. The Remote pane
 * shows the active connection's tabs (none without one). The strip scrolls
 * sideways when the tabs overflow it.
 */

import { withHint } from "../lib/keymap";
import { baseName } from "../lib/path";
import { useKeymap } from "../lib/useKeymap";
import { usePaneStore, type PaneId } from "../state/paneStore";
import { tabSetOf, useTabsStore } from "../state/tabsStore";
import { AddIcon, CloseIcon } from "./icons";
import styles from "./TabBar.module.css";

/** A tab's caption while its folder is not known yet (it opens at home). */
const HOME_TITLE = "Home";

export function TabBar({ pane }: { pane: PaneId }) {
  const tabs = useTabsStore((s) => tabSetOf(s, pane));
  // The tab on screen lives in paneStore; its snapshot is stale.
  const shownPath = usePaneStore((s) => s.panes[pane].path);
  const keymap = useKeymap();
  if (!tabs) return null;
  const closable = tabs.tabs.length > 1;
  const store = useTabsStore.getState;

  return (
    <div
      className={styles.bar}
      role="tablist"
      aria-label={`${pane === "local" ? "Local" : "Remote"} tabs`}
    >
      {tabs.tabs.map((tab) => {
        const active = tab.id === tabs.activeTabId;
        const path =
          (active ? shownPath : tab.pane.path) ?? tab.pendingPath ?? null;
        const title = path ? baseName(path) : HOME_TITLE;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={`${styles.tab}${active ? ` ${styles.active}` : ""}`}
            title={path ?? title}
            onClick={() => store().switchTab(pane, tab.id)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                store().switchTab(pane, tab.id);
              }
            }}
            onMouseDown={(e) => {
              // Keep the middle button from starting an autoscroll.
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              // Middle-click closes, as in a browser.
              if (e.button === 1) store().closeTab(pane, tab.id);
            }}
          >
            <span className={styles.title}>{title}</span>
            {closable && (
              <button
                type="button"
                className={styles.close}
                aria-label={`Close ${title}`}
                title={
                  active
                    ? withHint("Close tab", keymap, "closeTab")
                    : "Close tab"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  store().closeTab(pane, tab.id);
                }}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className={styles.add}
        title={withHint("New tab", keymap, "newTab")}
        aria-label="New tab"
        onClick={() => store().newTab(pane)}
      >
        <AddIcon size={13} />
      </button>
    </div>
  );
}
