/**
 * The sidebar's Connections section: saved connections with the state of
 * their one session, a context menu (connect or disconnect, edit, move,
 * delete) and the delete confirmation. A click picks the connection the
 * Remote pane shows (`openConnection`): one with a session is just shown,
 * one without connects first. The selected row is that active connection;
 * the others keep running in the background. Disconnect acts on the row's
 * own connection (its tabs stay, ready to Reconnect).
 *
 * The order is the user's: drag a row (`lib/rowReorder`), or ⌥⌘↑ / ⌥⌘↓ on a
 * focused row, or Move Up / Move Down in the menu. All three apply the new
 * order locally and hand it to `profilesStore.reorder`, which sends it to the
 * core and re-reads the list.
 *
 * A connection's favorite folders list under its row (`FavoriteList`),
 * folded away with its disclosure (remembered in `layoutStore`). A click
 * makes the connection active, connecting it when needed, and opens the
 * folder there (`openRemoteFavorite`).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { toIpcError } from "../ipc/commands";
import type { ConnectionProfile, ProfileId } from "../ipc/types";
import { disconnectSession, openConnection } from "../lib/connect";
import { hasUnfinishedTransfers } from "../lib/connections";
import { openRemoteFavorite } from "../lib/favorites";
import {
  formatBinding,
  MOVE_CONNECTION_DOWN,
  MOVE_CONNECTION_UP,
} from "../lib/keymap";
import { beginRowReorder, moveBy, moveToInsertion } from "../lib/rowReorder";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { useLayoutStore } from "../state/layoutStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { connectionState, useTabsStore } from "../state/tabsStore";
import { toastError } from "../state/toastStore";
import { ConnectionRow } from "./ConnectionRow";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FavoriteList } from "./FavoriteList";
import { Modal } from "./Modal";
import { SectionTitle } from "./SectionTitle";
import { ServerIcon } from "./icons";
import styles from "./Sidebar.module.css";

export function ConnectionSidebar() {
  const profiles = useProfilesStore((s) => s.profiles);
  const loaded = useProfilesStore((s) => s.loaded);
  const sessions = useSessionStore((s) => s.sessions);
  const connections = useTabsStore((s) => s.connections);
  const activeProfileId = useTabsStore((s) => s.activeProfileId);
  const openEdit = useConnectionFormStore((s) => s.openEdit);
  const collapsedFavorites = useLayoutStore((s) => s.collapsedFavorites);

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

  /** The profile's session, if it has one: what Disconnect acts on. */
  const sessionOf = (profile: ConnectionProfile) =>
    connections[profile.id]?.sessionId ?? null;

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
    const sessionId = sessionOf(profile);
    return [
      sessionId
        ? {
            label: "Disconnect",
            onSelect: () => disconnectSession(sessionId),
          }
        : {
            label: "Connect",
            onSelect: () => void openConnection(profile),
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
    const anyFavorites = profiles.some((p) => p.favorites.length > 0);
    body = (
      <div
        role="list"
        aria-label="Saved connections"
        className={styles.list}
        ref={listRef}
      >
        {profiles.map((profile, index) => {
          const sessionId = sessionOf(profile);
          // The line sits before the row the dragged one lands in front of,
          // or after the last row.
          const insert =
            drag?.insert === index
              ? "before"
              : drag?.insert === profiles.length &&
                  index === profiles.length - 1
                ? "after"
                : undefined;
          const favorites = profile.favorites;
          const expanded = !collapsedFavorites.includes(profile.id);
          return (
            <ConnectionRow
              key={profile.id}
              profile={profile}
              state={connectionState(connections[profile.id], sessions)}
              active={activeProfileId === profile.id}
              canDisconnect={sessionId !== null}
              onOpen={() => void openConnection(profile)}
              onEdit={() => openEdit(profile)}
              onDisconnect={() => sessionId && disconnectSession(sessionId)}
              onContextMenu={(e) => {
                setMenu({ x: e.clientX, y: e.clientY, profile });
                setMenuOpen(true);
              }}
              onPress={(e) => startReorder(profile, e)}
              onMove={(delta) => moveProfile(profile, delta)}
              reordering={drag?.id === profile.id}
              insert={insert}
              alignWithDisclosures={anyFavorites}
              favorites={
                favorites.length > 0
                  ? {
                      expanded,
                      onToggle: () =>
                        useLayoutStore
                          .getState()
                          .setFavoritesExpanded(profile.id, !expanded),
                    }
                  : undefined
              }
            >
              <FavoriteList
                scope={{ kind: "remote", profileId: profile.id }}
                favorites={favorites}
                label={`Favorites of ${profile.name}`}
                nested
                onOpen={(fav, newTab) =>
                  void openRemoteFavorite(profile, fav.path, newTab)
                }
              />
            </ConnectionRow>
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
          {deleting && sessionOf(deleting) !== null
            ? hasUnfinishedTransfers(sessionOf(deleting))
              ? " It is disconnected, and its unfinished transfers are cancelled."
              : " It is disconnected."
            : null}
        </p>
      </Modal>
    </section>
  );
}
