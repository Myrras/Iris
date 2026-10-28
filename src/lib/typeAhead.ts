/**
 * Finder-style type-to-select: typed characters build a prefix buffer that
 * picks a row of the visible listing. Pure rules; the pane wires the keys.
 */

import type { Entry } from "../ipc/types";

/** Quiet time after which the typed prefix starts over (behaviour, not motion). */
export const TYPE_AHEAD_RESET_MS = 1000;

// Same comparison as the name sort in `entries.ts`: natural, case- and
// accent-insensitive.
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const norm = (s: string) => s.normalize("NFC");

/**
 * The index in `entries` (the rows as displayed) to select for `buffer`: the
 * first name starting with it; else the entry that would sort right after it
 * by name (Finder's closest match); else, when the buffer sorts after every
 * name, the last one in name order. `null` for an empty buffer or no rows.
 */
export function matchTypeAhead(
  entries: Entry[],
  buffer: string,
): number | null {
  const needle = norm(buffer);
  if (needle === "" || entries.length === 0) return null;
  const names = entries.map((e) => norm(e.name));
  const prefix = names.findIndex(
    (n) => collator.compare(n.slice(0, needle.length), needle) === 0,
  );
  if (prefix !== -1) return prefix;

  let after = -1;
  let last = 0;
  names.forEach((n, i) => {
    if (collator.compare(n, names[last]) > 0) last = i;
    if (
      collator.compare(n, needle) > 0 &&
      (after === -1 || collator.compare(n, names[after]) < 0)
    ) {
      after = i;
    }
  });
  return after === -1 ? last : after;
}

export interface TypeAheadBuffer {
  /** Append `text` (starting over when the buffer went stale); returns it. */
  push: (text: string) => string;
  /** Typing is in progress: a non-empty buffer inside the reset window. */
  active: () => boolean;
  reset: () => void;
}

/** The typed prefix, expiring `resetMs` after the last keystroke. */
export function createTypeAheadBuffer(
  now: () => number = () => Date.now(),
  resetMs: number = TYPE_AHEAD_RESET_MS,
): TypeAheadBuffer {
  let value = "";
  let last = 0;
  const active = () => value !== "" && now() - last < resetMs;
  return {
    push(text) {
      if (!active()) value = "";
      value += text;
      last = now();
      return value;
    },
    active,
    reset() {
      value = "";
    },
  };
}
