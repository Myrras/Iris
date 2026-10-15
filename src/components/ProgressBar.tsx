/**
 * Thin progress bar, copied from Selene's `OperationProgress` (its track +
 * transform-scaled fill, and the indeterminate sliding segment), without the
 * label row. `fraction` is 0–1; `null` slides indeterminately (size not yet
 * known). `tone` tints the fill for finished states.
 */

import styles from "./ProgressBar.module.css";

export function ProgressBar({
  fraction,
  label,
  tone = "active",
}: {
  fraction: number | null;
  /** Accessible name, e.g. "notes.txt progress". */
  label: string;
  tone?: "active" | "done" | "error" | "muted";
}) {
  const known = fraction !== null;
  const clamped = known ? Math.max(0, Math.min(1, fraction)) : 0;
  return (
    <div
      className={styles.bar}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(clamped * 100) : undefined}
      data-tone={tone}
    >
      {known ? (
        <div
          className={styles.fill}
          style={{ transform: `scaleX(${clamped})` }}
        />
      ) : (
        <div className={styles.fillIndeterminate} />
      )}
    </div>
  );
}
