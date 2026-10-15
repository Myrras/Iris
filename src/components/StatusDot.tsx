/**
 * Small coloured dot summarizing a lifecycle state (Podium's StatusDot, made
 * generic): a connection, and later a transfer. `pulse` animates it for
 * in-progress states.
 */

import styles from "./StatusDot.module.css";

export type StatusTone = "idle" | "busy" | "ok" | "warning" | "error";

export function StatusDot({
  tone,
  label,
  pulse = false,
}: {
  tone: StatusTone;
  /** Accessible name and tooltip, e.g. "Connected". */
  label: string;
  /** Pulse while something is in progress (connecting, transferring). */
  pulse?: boolean;
}) {
  return (
    <span
      className={styles.dot}
      data-tone={tone}
      data-pulse={pulse ? "true" : undefined}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}
