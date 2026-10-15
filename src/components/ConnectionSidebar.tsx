/**
 * The sidebar's Connections section: saved connections with their live state
 * (summed over every tab's session of the profile), a context menu (connect,
 * connect in a new tab, disconnect, edit, delete) and the delete
 * confirmation. Connecting goes through `connectProfile`: in the tab on
 * screen when it is free, else in a new tab. Disconnect acts on the tab on
 * screen, so it is offered only on the row of that tab's profile.
 */

import { useCallback, useState } from "react";

import { toIpcError } from "../ipc/commands";
import type { ConnectionProfile } from "../ipc/types";
import { connectProfile, disconnectSession } from "../lib/connect";
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
      <div role="list" aria-label="Saved connections" className={styles.list}>
        {profiles.map((profile) => {
          const session = summarySessionFor(sessions, profile.id);
          const active = activeProfileId === profile.id;
          return (
            <div role="listitem" key={profile.id}>
              <ConnectionRow
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
              />
            </div>
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
