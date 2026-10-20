/**
 * Middle truncation of paths for the transfer list, so both the start (the
 * root / first folders) and the end (the folder next to the file) stay
 * visible: `/Users/me/…/src/lib`.
 *
 * Pure and width-agnostic: the caller passes how many characters fit.
 * `charsThatFit` turns a pixel width into that count. CSS-only middle
 * ellipsis (two spans, `direction: rtl` tricks) is not used: it mangles
 * paths that mix separators and bidi-neutral characters and its behaviour
 * differs between WebKit and WebView2, so the text is cut in JS instead.
 */

const ELLIPSIS = "…";

/** Average glyph width (px) of the muted path line at `--fs-xs`; a slightly
 *  generous value, so a path is cut a little early rather than clipped. */
export const AVG_CHAR_PX = 6.4;

/** How many characters fit in `widthPx` (at least 8). */
export function charsThatFit(widthPx: number, charPx = AVG_CHAR_PX): number {
  return Math.max(8, Math.floor(widthPx / charPx));
}

/** `text` cut in its middle to `max` characters (code points, not UTF-16). */
function cutMiddle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return ELLIPSIS;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return (
    chars.slice(0, head).join("") +
    ELLIPSIS +
    chars.slice(chars.length - (keep - head)).join("")
  );
}

const length = (s: string) => Array.from(s).length;

/**
 * `path` shortened to at most `maxChars` characters. A path that fits is
 * returned unchanged. Otherwise the last segment is always kept (as many
 * trailing segments as fit in ~60 % of the room), the start fills the rest,
 * and `…` sits between. A single segment longer than the room is cut in its
 * own middle.
 */
export function ellipsizePath(path: string, maxChars: number): string {
  if (length(path) <= maxChars) return path;
  if (maxChars <= 1) return ELLIPSIS;

  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(sep);
  const room = maxChars - 1;
  const tailRoom = Math.ceil(room * 0.6);

  // Trailing segments, last one first, while they fit.
  let tail = "";
  let i = parts.length;
  while (i > 1) {
    const next = sep + parts[i - 1] + tail;
    if (tail !== "" && length(next) > tailRoom) break;
    tail = next;
    i--;
    if (length(tail) > tailRoom) break;
  }
  if (length(tail) > tailRoom) {
    // The last segment alone is too long: shorten it in its middle.
    return cutMiddle(path, maxChars);
  }

  // Leading segments, first one first, in what is left.
  const headRoom = room - length(tail);
  let head = "";
  for (let k = 0; k < i; k++) {
    const next = k === 0 ? parts[0] : head + sep + parts[k];
    if (length(next) > headRoom) break;
    head = next;
  }
  if (head === "") {
    head = Array.from(parts.slice(0, i).join(sep))
      .slice(0, Math.max(headRoom, 0))
      .join("");
  }
  return head + ELLIPSIS + tail;
}
