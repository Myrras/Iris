/**
 * Local date/time labels. Modelled on Podium's `lib/dateFormat.ts`
 * (`formatTime`), but fed unix seconds and with the year: a file can be
 * years old, which Podium's activity labels never are.
 */

/** Local "Mar 5, 2024, 14:07"-style label; empty string for unknown. */
export function formatModified(unixSeconds: number | null): string {
  if (unixSeconds === null) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
