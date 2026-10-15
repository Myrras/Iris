/**
 * One saved connection in the sidebar: status dot, name, hover actions —
 * Podium's ProcessRow, with a connection's lifecycle on the dot. Clicking
 * connects (or shows the open session); right-click opens the row's menu.
 */

import type { ConnectionProfile } from "../ipc/types";
import type { SessionInfo } from "../state/sessionStore";
import { StatusDot, type StatusTone } from "./StatusDot";
import { DisconnectIcon, EditIcon } from "./icons";
import styles from "./ConnectionRow.module.css";

/** Dot tone, label and pulse for a profile's latest session. */
function connectionStatus(session: SessionInfo | undefined): {
  tone: StatusTone;
  label: string;
  pulse: boolean;
} {
  switch (session?.state) {
    case "connecting":
      return { tone: "busy", label: "Connecting…", pulse: true };
    case "connected":
      return { tone: "ok", label: "Connected", pulse: false };
    case "disconnected":
      return session.reason
        ? { tone: "error", label: session.reason, pulse: false }
        : { tone: "idle", label: "Not connected", pulse: false };
    default:
      return { tone: "idle", label: "Not connected", pulse: false };
  }
}

export function ConnectionRow({
  profile,
  session,
  active,
  onConnect,
  onEdit,
  onDisconnect,
  onContextMenu,
}: {
  profile: ConnectionProfile;
  /** The profile's latest session, if any. */
  session: SessionInfo | undefined;
  /** Shown in the remote pane right now. */
  active: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onDisconnect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const status = connectionStatus(session);
  const connected = session?.state === "connected";

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
        {connected && (
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
