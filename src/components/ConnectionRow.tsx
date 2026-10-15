/**
 * One saved connection in the sidebar: status dot, name, hover actions —
 * Podium's ProcessRow, with a connection's lifecycle on the dot (across all
 * of the profile's tabs). Clicking connects (in the tab on screen when it is
 * free, else in a new tab); right-click opens the row's menu.
 */

import type { ConnectionProfile } from "../ipc/types";
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
}) {
  const status = sessionStatus(session?.state);

  return (
    <div
      className={styles.row}
      data-selected={active ? "true" : undefined}
      role="button"
      tabIndex={0}
      title={`${profile.user}@${profile.host}:${profile.port}`}
      onClick={onConnect}
      onKeyDown={(e) => {
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
      <StatusDot tone={status.tone} label={status.label} pulse={status.pulse} />
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
  );
}
