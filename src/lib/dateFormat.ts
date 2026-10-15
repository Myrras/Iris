/**
 * Local date/time labels for the file table's Modified column, after
 * Podium's `lib/dateFormat.ts` (`formatTime`) but fed unix seconds.
 *
 * The cell is narrow, so it is compact the Finder way: this year's dates show
 * day, month and time ("14 Oct 16:15"); older ones day, month and year
 * ("5 Mar 2024"). The full timestamp goes in the tooltip.
 */

/** Compact cell label; empty for unknown. `now` is injectable for tests. */
export function formatModified(
  unixSeconds: number | null,
  now: Date = new Date(),
): string {
  if (unixSeconds === null) return "";
  const d = new Date(unixSeconds * 1000);
  if (d.getFullYear() === now.getFullYear()) {
    const day = d.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
    });
    const time = d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${day} ${time}`;
  }
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Full local date and time (tooltip); empty for unknown. */
export function formatModifiedFull(unixSeconds: number | null): string {
  if (unixSeconds === null) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
