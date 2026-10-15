/**
 * The sidebar's Connections section: saved connections with their live state,
 * a context menu (connect / disconnect / edit / delete) and the delete
 * confirmation. Connecting goes through `connectProfile`, which shows the
 * session in the remote pane.
 */

import { useCallback, useState } from "react";

import { toIpcError } from "../ipc/commands";
import type { ConnectionProfile } from "../ipc/types";
import { connectProfile, disconnectSession } from "../lib/connect";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { usePaneStore } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { latestSessionFor, useSessionStore } from "../state/sessionStore";
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
  const remoteTarget = usePaneStore((s) => s.panes.remote.target);
  const openNew = useConnectionFormStore((s) => s.openNew);
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

  const activeSessionId =
    remoteTarget?.kind === "remote" ? remoteTarget.sessionId : null;

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
    const session = latestSessionFor(sessions, profile.id);
    const connected = session?.state === "connected";
    return [
      connected && session
        ? {
            label: "Disconnect",
            onSelect: () => void disconnectSession(session.sessionId),
          }
        : {
            label: "Connect",
            disabled: session?.state === "connecting",
            onSelect: () => void connectProfile(profile),
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
    body = (
      <div className={styles.placeholder}>
        <span>No connections yet.</span>
        <button type="button" className={styles.linkBtn} onClick={openNew}>
          Add a server…
        </button>
      </div>
    );
  } else {
    body = (
      <div role="list" aria-label="Saved connections" className={styles.list}>
        {profiles.map((profile) => {
          const session = latestSessionFor(sessions, profile.id);
          return (
            <div role="listitem" key={profile.id}>
              <ConnectionRow
                profile={profile}
                session={session}
                active={
                  session !== undefined && session.sessionId === activeSessionId
                }
                onConnect={() => void connectProfile(profile)}
                onEdit={() => openEdit(profile)}
                onDisconnect={() =>
                  session && void disconnectSession(session.sessionId)
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
