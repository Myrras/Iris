/**
 * The sidebar's Connections section: saved connections with their live state
 * (summed over every tab's session of the profile), a context menu (connect,
 * connect in a new tab, disconnect, edit, delete) and the delete
 * confirmation. Connecting goes through `connectProfile`: in the tab on
 * screen when it is free, else in a new tab. Disconnect acts on the tab on
 * screen, so it is offered only on the row of that tab's profile.
 *
 * The order is the user's: drag a row (`lib/rowReorder`), or ⌥⌘↑ / ⌥⌘↓ on a
 * focused row, or Move Up / Move Down in the menu. All three apply the new
 * order locally and hand it to `profilesStore.reorder`, which sends it to the
 * core and re-reads the list.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { toIpcError } from "../ipc/commands";
import type { ConnectionProfile, ProfileId } from "../ipc/types";
import { connectProfile, disconnectSession } from "../lib/connect";
import {
  formatBinding,
  MOVE_CONNECTION_DOWN,
  MOVE_CONNECTION_UP,
} from "../lib/keymap";
import { beginRowReorder, moveBy, moveToInsertion } from "../lib/rowReorder";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { useProfilesStore } from "../state/profilesStore";
import { summarySessionFor, useSessionStore } from "../state/sessionStore";
import { useTabsStore } from "../state/tabsStore";
import { toastError } from "../state/toastStore";
import { ConnectionRow } from "./ConnectionRow";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Modal } from "./Modal";
import { SectionTitle } from "./SectionTitle";
import { ServerIcon } from "./icons";
import styles from "./Sidebar.module.css";

export function ConnectionSidebar() {
  const profiles = useProfilesStore((s) => s.profiles);
  const loaded = useProfilesStore((s) => s.loaded);
  const sessions = useSessionStore((s) => s.sessions);
  const activeTab = useTabsStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId),
  );
  const openEdit = useConnectionFormStore((s) => s.openEdit);

  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    profile: ConnectionProfile;
  } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState<ConnectionProfile | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // A reorder drag in flight: the dragged row and where the line shows.
  const [drag, setDrag] = useState<{
    id: ProfileId;
    insert: number | null;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  // The row to hand focus back to once a keyboard / menu move has re-rendered.
  const refocus = useRef<ProfileId | null>(null);

  // The list changing under a drag (another window, a delete) would leave
  // the insertion points meaning something else: drop the drag.
  useEffect(() => cancelDrag.current?.(), [profiles]);
  useEffect(() => () => cancelDrag.current?.(), []);
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const item = Array.from(listRef.current?.children ?? []).find(
      (el) => (el as HTMLElement).dataset.profileId === id,
    );
    item?.querySelector<HTMLElement>('[role="button"]')?.focus();
  }, [profiles]);

  function startReorder(profile: ConnectionProfile, e: React.MouseEvent) {
    const from = profiles.findIndex((p) => p.id === profile.id);
    if (profiles.length < 2 || from < 0) return;
    cancelDrag.current = beginRowReorder({
      x: e.clientX,
      y: e.clientY,
      from,
      list: () => listRef.current,
      onStart: () => setDrag({ id: profile.id, insert: null }),
      onInsert: (insert) => setDrag((d) => d && { ...d, insert }),
      onDrop: (insert) =>
        void useProfilesStore
          .getState()
          .reorder(moveToInsertion(profiles, from, insert).map((p) => p.id)),
      onEnd: () => {
        cancelDrag.current = null;
        setDrag(null);
      },
    });
  }

  /** One place up (−1) or down (1); nothing past the first / last. */
  function moveProfile(profile: ConnectionProfile, delta: -1 | 1) {
    const ids = moveBy(
      profiles.map((p) => p.id),
      profile.id,
      delta,
    );
    if (!ids) return;
    refocus.current = profile.id;
    void useProfilesStore.getState().reorder(ids);
  }

  const activeProfileId = activeTab?.profileId ?? null;
  // The session of the tab on screen: what Disconnect acts on.
  const activeSession = activeTab?.sessionId
    ? sessions[activeTab.sessionId]
    : undefined;

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeDelete = useCallback(() => {
    if (!deleteBusy) setDeleting(null);
  }, [deleteBusy]);

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await useProfilesStore.getState().remove(deleting.id);
      setDeleting(null);
    } catch (e) {
      toastError(`Could not delete ${deleting.name}`, toIpcError(e).message);
    } finally {
      setDeleteBusy(false);
    }
  }

  function menuItems(profile: ConnectionProfile): ContextMenuItem[] {
    const ownsActive =
      activeSession !== undefined && activeSession.profileId === profile.id;
    return [
      ownsActive && activeSession.state.status !== "disconnected"
        ? {
            label: "Disconnect",
            onSelect: () => disconnectSession(activeSession.sessionId),
          }
        : {
            label: "Connect",
            onSelect: () => void connectProfile(profile),
          },
      {
        label: "Connect in New Tab",
        onSelect: () => void connectProfile(profile, { newTab: true }),
      },
      { label: "Edit…", onSelect: () => openEdit(profile) },
      {
        label: "Move Up",
        shortcut: formatBinding(MOVE_CONNECTION_UP),
        disabled: profiles[0]?.id === profile.id,
        onSelect: () => moveProfile(profile, -1),
      },
      {
        label: "Move Down",
        shortcut: formatBinding(MOVE_CONNECTION_DOWN),
        disabled: profiles[profiles.length - 1]?.id === profile.id,
        onSelect: () => moveProfile(profile, 1),
      },
      { label: "Delete…", danger: true, onSelect: () => setDeleting(profile) },
    ];
  }

  let body;
  if (!loaded) {
    body = (
      <div className={styles.placeholder}>
        <span>
          <span className="spinner" aria-hidden /> Loading…
        </span>
      </div>
    );
  } else if (profiles.length === 0) {
    // The footer's "New connection…" is the one call to action.
    body = <div className={styles.placeholder}>No connections yet.</div>;
  } else {
    body = (
      <div
        role="list"
        aria-label="Saved connections"
        className={styles.list}
        ref={listRef}
      >
        {profiles.map((profile, index) => {
          const session = summarySessionFor(sessions, profile.id);
          const active = activeProfileId === profile.id;
          // The line sits before the row the dragged one lands in front of,
          // or after the last row.
          const insert =
            drag?.insert === index
              ? "before"
              : drag?.insert === profiles.length &&
                  index === profiles.length - 1
                ? "after"
                : undefined;
          return (
            <ConnectionRow
              key={profile.id}
              profile={profile}
              session={session}
              active={active}
              canDisconnect={
                active &&
                activeSession?.profileId === profile.id &&
                activeSession.state.status !== "disconnected"
              }
              onConnect={() => void connectProfile(profile)}
              onEdit={() => openEdit(profile)}
              onDisconnect={() =>
                activeSession && disconnectSession(activeSession.sessionId)
              }
              onContextMenu={(e) => {
                setMenu({ x: e.clientX, y: e.clientY, profile });
                setMenuOpen(true);
              }}
              onPress={(e) => startReorder(profile, e)}
              onMove={(delta) => moveProfile(profile, delta)}
              reordering={drag?.id === profile.id}
              insert={insert}
            />
          );
        })}
      </div>
    );
  }

  return (
    <section className={styles.subsection}>
      <div className={styles.sectionHeader}>
        <SectionTitle
          title="Connections"
          Icon={ServerIcon}
          count={profiles.length}
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
        />
      </div>
      <div
        className={`${styles.sectionBody}${collapsed ? ` ${styles.sectionBodyCollapsed}` : ""}`}
      >
        <div className={styles.sectionBodyInner}>{body}</div>
      </div>

      <ContextMenu
        open={menuOpen}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu ? menuItems(menu.profile) : []}
        onClose={closeMenu}
      />

      <Modal
        open={deleting !== null}
        title="Delete connection"
        tone="danger"
        onClose={closeDelete}
        width={400}
        footer={
          <>
            <button type="button" onClick={closeDelete} disabled={deleteBusy}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void confirmDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </button>
          </>
        }
      >
        <p className={styles.confirmText}>
          Delete <strong>{deleting?.name}</strong>? The saved connection is
          removed; files on the server are not touched.
        </p>
      </Modal>
    </section>
  );
}
