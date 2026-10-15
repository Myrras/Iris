/**
 * Unix permission modes for the permissions dialog: the octal text field and
 * the read/write/execute grid edit the same number.
 */

export type PermissionWho = "owner" | "group" | "other";
export type PermissionWhat = "read" | "write" | "execute";

export const WHO: readonly PermissionWho[] = ["owner", "group", "other"];
export const WHAT: readonly PermissionWhat[] = ["read", "write", "execute"];

/** The bit for one cell of the grid (`owner`+`read` = `0o400`). */
export function permissionBit(
  who: PermissionWho,
  what: PermissionWhat,
): number {
  const shift = { owner: 6, group: 3, other: 0 }[who];
  const bit = { read: 4, write: 2, execute: 1 }[what];
  return bit << shift;
}

/** `mode` with one grid cell switched on or off. */
export function withPermission(
  mode: number,
  who: PermissionWho,
  what: PermissionWhat,
  on: boolean,
): number {
  const bit = permissionBit(who, what);
  return on ? mode | bit : mode & ~bit;
}

/**
 * Octal text (3 or 4 digits, as `chmod` takes it) → mode, or `null` when it
 * is not a valid mode. A 4th leading digit carries setuid/setgid/sticky.
 */
export function parseOctalMode(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-7]{3,4}$/.test(trimmed)) return null;
  return parseInt(trimmed, 8);
}

/**
 * The permission part of `mode` (type bits dropped) as octal text: three
 * digits, or four when setuid/setgid/sticky are set.
 */
export function formatOctalMode(mode: number): string {
  const perm = mode & 0o7777;
  return perm > 0o777
    ? perm.toString(8).padStart(4, "0")
    : perm.toString(8).padStart(3, "0");
}
