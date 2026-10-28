/**
 * One saved connection in the sidebar: status dot, name, hover actions —
 * Podium's ProcessRow, with a connection's lifecycle on the dot (across all
 * of the profile's tabs). Clicking connects (in the tab on screen when it is
 * free, else in a new tab); right-click opens the row's menu. Pressing and
 * dragging reorders (`lib/rowReorder`, driven by the sidebar), ⌥⌘↑ / ⌥⌘↓ moves
 * the focused row. The row renders its own list item so the insertion line
 * can sit on the item's edge.
 */

import type { ConnectionProfile } from "../ipc/types";
import { connectionMoveOf } from "../lib/keymap";
import { sessionStatus } from "../lib/sessionStatus";
import type { SessionInfo } from "../state/sessionStore";
import { StatusDot } from "./StatusDot";
import { DisconnectIcon, EditIcon } from "./icons";
import styles from "./ConnectionRow.module.css";

export function ConnectionRow({
  profile,
  session,
  active,
  canDisconnect,
  onConnect,
  onEdit,
  onDisconnect,
  onContextMenu,
  onPress,
  onMove,
  reordering,
  insert,
}: {
  profile: ConnectionProfile;
  /** The session that speaks for the profile (`summarySessionFor`). */
  session: SessionInfo | undefined;
  /** The tab on screen is about this profile. */
  active: boolean;
  /** The tab on screen has a session of this profile to disconnect. */
  canDisconnect: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDisconnect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** A primary-button press on the row (not on its buttons): may become a drag. */
  onPress: (e: React.MouseEvent) => void;
  /** ⌥⌘↑ / ⌥⌘↓ on the focused row: one place up (−1) or down (1). */
  onMove: (delta: -1 | 1) => void;
  /** This row is the one being dragged. */
  reordering: boolean;
  /** Draw the insertion line on this item's top or bottom edge. */
  insert: "before" | "after" | undefined;
}) {
  const status = sessionStatus(session?.state);

  return (
    <div
      role="listitem"
      className={styles.item}
      data-profile-id={profile.id}
      data-insert={insert}
    >
      <div
        className={styles.row}
        data-selected={active ? "true" : undefined}
        data-reordering={reordering ? "true" : undefined}
        role="button"
        tabIndex={0}
        title={`${profile.user}@${profile.host}:${profile.port}`}
        onClick={onConnect}
        onMouseDown={(e) => {
          // Not a context-menu click (Ctrl on a Mac), not the row's buttons.
          if (e.button !== 0 || e.ctrlKey) return;
          if ((e.target as HTMLElement).closest("button")) return;
          onPress(e);
        }}
        onKeyDown={(e) => {
          const delta = connectionMoveOf(e);
          if (delta) {
            // Not the pane's or the window's shortcut: keep it from them.
            e.preventDefault();
            e.stopPropagation();
            onMove(delta);
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onConnect();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e);
        }}
      >
        <StatusDot
          tone={status.tone}
          label={status.label}
          pulse={status.pulse}
        />
        <span className={styles.name}>{profile.name}</span>
        <span className={styles.actions} onClick={(e) => e.stopPropagation()}>
          {canDisconnect && (
            <button
              type="button"
              className={styles.action}
              aria-label={`Disconnect ${profile.name}`}
              title="Disconnect"
              onClick={onDisconnect}
            >
              <DisconnectIcon size={12} />
            </button>
          )}
          <button
            type="button"
            className={styles.action}
            aria-label={`Edit ${profile.name}`}
            title="Edit"
            onClick={onEdit}
          >
            <EditIcon size={12} />
          </button>
        </span>
      </div>
    </div>
  );
}
