/**
 * The workspace tab strip above the two pane islands (Selene's TabBar): one
 * chip per tab with its session's status dot, title and close button;
 * middle-click closes, drag reorders, `+` opens a blank tab. The strip
 * scrolls sideways when the tabs overflow it.
 *
 * Closing goes through `requestCloseTab`, which asks first (`TabCloseModal`)
 * when the tab's session still has transfers.
 */

import { useRef, useState } from "react";

import { sessionStatus, type SessionStatusView } from "../lib/sessionStatus";
import { requestCloseTab } from "../lib/tabs";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore, type SessionInfo } from "../state/sessionStore";
import { useTabsStore, type Tab } from "../state/tabsStore";
import { StatusDot } from "./StatusDot";
import { AddIcon, CloseIcon } from "./icons";
import styles from "./TabBar.module.css";

/** A tab's dot: its connect in progress, else its session's state. */
function tabStatus(
  tab: Tab,
  session: SessionInfo | undefined,
): SessionStatusView {
  if (tab.connecting) return sessionStatus({ status: "connecting" });
  if (!tab.sessionId) return sessionStatus(undefined);
  // The tab got the session once `connect` resolved: it is up even before
  // its state event arrived.
  return sessionStatus(session?.state ?? { status: "connected" });
}

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const sessions = useSessionStore((s) => s.sessions);
  const profiles = useProfilesStore((s) => s.profiles);

  // Drag-to-reorder: the dragged tab's id lives in a ref (no re-render
  // needed); `overId` drives the insertion line.
  const dragId = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const endDrag = () => {
    dragId.current = null;
    setOverId(null);
  };

  return (
    <div className={styles.bar} role="tablist" aria-label="Tabs">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        // A renamed profile renames its tabs.
        const title =
          profiles.find((p) => p.id === tab.profileId)?.name ?? tab.title;
        const status = tabStatus(
          tab,
          tab.sessionId ? sessions[tab.sessionId] : undefined,
        );
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={`${styles.tab}${active ? ` ${styles.active}` : ""}${
              overId === tab.id ? ` ${styles.over}` : ""
            }`}
            draggable
            title={title}
            onClick={() => useTabsStore.getState().switchTo(tab.id)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                useTabsStore.getState().switchTo(tab.id);
              }
            }}
            onMouseDown={(e) => {
              // Keep the middle button from starting an autoscroll.
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              // Middle-click closes, as in a browser.
              if (e.button === 1) requestCloseTab(tab.id);
            }}
            onDragStart={(e) => {
              dragId.current = tab.id;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnter={(e) => {
              if (dragId.current === null) return;
              e.preventDefault();
              if (tab.id !== dragId.current) setOverId(tab.id);
            }}
            onDragOver={(e) => {
              if (dragId.current === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragId.current;
              endDrag();
              if (from && from !== tab.id) {
                useTabsStore.getState().moveTab(from, tab.id);
              }
            }}
            onDragEnd={endDrag}
          >
            <StatusDot
              tone={status.tone}
              label={status.label}
              pulse={status.pulse}
            />
            <span className={styles.title}>{title}</span>
            <button
              type="button"
              className={styles.close}
              aria-label={`Close ${title}`}
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                requestCloseTab(tab.id);
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className={styles.add}
        title="New tab"
        aria-label="New tab"
        onClick={() => useTabsStore.getState().newTab()}
      >
        <AddIcon />
      </button>
    </div>
  );
}
