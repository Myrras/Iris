/** Display formatting for file-table cells (size and permission columns). */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Human-readable size in binary units: "512 B", "1.5 KB", "150 KB". One
 * decimal below 100 of a unit keeps small sizes precise without making large
 * ones noisy.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value < 100
    ? `${value.toFixed(1)} ${UNITS[unit]}`
    : `${Math.round(value)} ${UNITS[unit]}`;
}

/** `S_IFMT` file-type nibble → the `ls -l` type character. */
const TYPE_CHARS: Record<number, string> = {
  0o140000: "s", // socket
  0o120000: "l", // symlink
  0o100000: "-", // regular file
  0o060000: "b", // block device
  0o040000: "d", // directory
  0o020000: "c", // character device
  0o010000: "p", // fifo
};

/**
 * `ls -l`-style permission string (`drwxr-xr-x`) from unix mode bits,
 * including setuid/setgid (`s`/`S`) and sticky (`t`/`T`). Empty when the mode
 * is unknown (Windows). Mode bits without a type count as a regular file.
 */
export function formatPermissions(mode: number | null): string {
  if (mode === null) return "";
  const type = TYPE_CHARS[mode & 0o170000] ?? "-";
  // Each triple: read, write, execute — where the special bit (setuid,
  // setgid, sticky) replaces the execute slot: lower-case when execute is
  // also set, upper-case when it is not.
  const triple = (shift: number, special: boolean, specialChar: string) => {
    const bits = (mode >> shift) & 0o7;
    const exec = (bits & 1) !== 0;
    const x = special
      ? exec
        ? specialChar
        : specialChar.toUpperCase()
      : exec
        ? "x"
        : "-";
    return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${x}`;
  };
  return (
    type +
    triple(6, (mode & 0o4000) !== 0, "s") +
    triple(3, (mode & 0o2000) !== 0, "s") +
    triple(0, (mode & 0o1000) !== 0, "t")
  );
}
