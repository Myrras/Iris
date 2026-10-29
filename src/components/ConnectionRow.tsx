/**
 * One saved connection in the sidebar: status dot, name, hover actions —
 * Podium's ProcessRow, with the connection's lifecycle on the dot. Clicking
 * shows the connection in the Remote pane (connecting it when it has no
 * session); the active one is drawn selected. Right-click opens the row's
 * menu. Pressing and
 * dragging reorders (`lib/rowReorder`, driven by the sidebar), ⌥⌘↑ / ⌥⌘↓ moves
 * the focused row. The row renders its own list item so the insertion line
 * can sit on the item's edge.
 *
 * A connection with favorite folders gets a ▸/▾ disclosure in front of the
 * dot; when it is open the favorites (`children`, a `FavoriteList`) show
 * under the row, inside the same list item.
 */

import type { ReactNode } from "react";

import type { ConnectionProfile, SessionState } from "../ipc/types";
import { connectionMoveOf } from "../lib/keymap";
import { sessionStatus } from "../lib/sessionStatus";
import { StatusDot } from "./StatusDot";
import { CaretIcon, DisconnectIcon, EditIcon } from "./icons";
import styles from "./ConnectionRow.module.css";

export function ConnectionRow({
  profile,
  state,
  active,
  canDisconnect,
  onOpen,
  onEdit,
  onDisconnect,
  onContextMenu,
  onPress,
  onMove,
  reordering,
  insert,
  favorites,
  alignWithDisclosures = false,
  children,
}: {
  profile: ConnectionProfile;
  /** The connection's state (`connectionState`); none = not connected. */
  state: SessionState | undefined;
  /** The Remote pane shows this connection. */
  active: boolean;
  /** The connection has a session to disconnect. */
  canDisconnect: boolean;
  /** Show it in the Remote pane, connecting first when needed. */
  onOpen: () => void;
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
  /** It has favorites: the disclosure's state; none = no disclosure. */
  favorites?: { expanded: boolean; onToggle: () => void };
  /** Other rows have a disclosure: keep its room so the dots line up. */
  alignWithDisclosures?: boolean;
  /** Shown under the row while `favorites.expanded` (the favorites list). */
  children?: ReactNode;
}) {
  const status = sessionStatus(state);

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
        onClick={onOpen}
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
          // Enter / Space on the row's own buttons press those instead.
          if ((e.target as HTMLElement).closest("button")) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e);
        }}
      >
        {favorites ? (
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={favorites.expanded}
            aria-label={`${favorites.expanded ? "Hide" : "Show"} favorites of ${profile.name}`}
            title={favorites.expanded ? "Hide favorites" : "Show favorites"}
            onClick={(e) => {
              e.stopPropagation();
              favorites.onToggle();
            }}
          >
            <span
              className={styles.caret}
              data-open={favorites.expanded ? "true" : undefined}
            >
              <CaretIcon size={12} />
            </span>
          </button>
        ) : alignWithDisclosures ? (
          <span className={styles.disclosureSpace} aria-hidden />
        ) : null}
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
      {favorites?.expanded && children}
    </div>
  );
}
