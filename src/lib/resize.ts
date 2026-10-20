/**
 * Pure rules for the resizable islands: limits, clamping, keyboard steps and
 * the one function that turns the stored preferences plus the window size into
 * the sizes actually shown (`resolveLayout`).
 *
 * The stored values are *preferences*; what is drawn is clamped to the window
 * on every resize and never written back, so a window that grows again gives
 * the user's own sizes back. When the window is too small the columns give way
 * in priority order: the sidebar first, then the preview, and the panes never
 * go below `PANE_MIN_PX` (the file table needs about 376 px before it
 * scrolls; 280 px keeps Name and Size readable).
 */

/** `--gap-island` (`--sp-2`) in px: the width of every splitter. Keep in sync with tokens.css. */
export const GAP_PX = 8;
/** `--statusbar-h` in px: the transfer island's header, always visible. */
export const TRANSFERS_HEADER_PX = 28;

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 600;
export const SIDEBAR_DEFAULT_WIDTH = 280;

export const PANE_MIN_PX = 280;
export const PANES_DEFAULT_RATIO = 0.5;
/** Outer bounds for a stored ratio; the window decides the real limits. */
export const PANES_RATIO_MIN = 0.05;
export const PANES_RATIO_MAX = 0.95;

export const PREVIEW_MIN_WIDTH = 240;
export const PREVIEW_DEFAULT_WIDTH = 340;
/** At most this share of the window. */
export const PREVIEW_MAX_FRACTION = 0.5;
/** Sanity cap for a stored width (the window decides the real limit). */
export const PREVIEW_STORED_MAX = 4000;

/** The transfer list (below its header): two rows at least. */
export const TRANSFERS_MIN_HEIGHT = 56;
export const TRANSFERS_DEFAULT_HEIGHT = 168;
/** The whole island (header included) takes at most this share of the window. */
export const TRANSFERS_MAX_FRACTION = 0.6;
export const TRANSFERS_STORED_MAX = 4000;

export const KEY_STEP_PX = 16;
export const KEY_STEP_LARGE_PX = 64;

export function clamp(value: number, min: number, max: number): number {
  // `max < min` happens in tiny windows: the minimum wins.
  return Math.max(min, Math.min(max, value));
}

/** A finite number, else `fallback`. */
export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export type Orientation = "vertical" | "horizontal";

/**
 * The size a key press asks for, or `null` when the key is not a resize key.
 *
 * `orientation` is the separator's (ARIA): a vertical line resizes widths and
 * answers Left/Right, a horizontal one resizes heights and answers Up/Down.
 * Arrows move the *handle*; `invert` is for splitters whose size grows when
 * the handle moves toward the window's start (the preview, the transfers).
 * Home/End are the minimum and the maximum, whatever the direction.
 */
export function keyboardTarget(
  key: string,
  shift: boolean,
  value: number,
  min: number,
  max: number,
  orientation: Orientation,
  invert = false,
): number | null {
  if (key === "Home") return min;
  if (key === "End") return max;
  const toward =
    orientation === "vertical"
      ? key === "ArrowLeft"
        ? -1
        : key === "ArrowRight"
          ? 1
          : 0
      : key === "ArrowUp"
        ? -1
        : key === "ArrowDown"
          ? 1
          : 0;
  if (toward === 0) return null;
  const step = shift ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
  return clamp(value + (invert ? -toward : toward) * step, min, max);
}

/** What the user chose; the layout store's persisted sizes. */
export interface LayoutPrefs {
  sidebarWidth: number;
  /** Share of the panes' width that the Local pane takes. */
  panesRatio: number;
  previewWidth: number;
  previewOpen: boolean;
  /** Height of the transfer job list (the header comes on top). */
  transfersHeight: number;
  transfersCollapsed: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Limits {
  min: number;
  max: number;
}

/** The sizes to draw, all in px except the grow weights. */
export interface ResolvedLayout {
  sidebar: number;
  /** 0 while the preview is closed (it takes no space). */
  preview: number;
  /** The width the preview opens at, also while it is closed. */
  previewWidth: number;
  local: number;
  remote: number;
  /** Local + remote: the width the ratio refers to. */
  panesTotal: number;
  /** Local's share of `panesTotal`, after clamping. */
  ratio: number;
  transfers: number;
  limits: {
    sidebar: Limits;
    preview: Limits;
    local: Limits;
    transfers: Limits;
  };
}

/** The sizes shown for `prefs` in a window of `viewport`. */
export function resolveLayout(
  prefs: LayoutPrefs,
  viewport: Viewport,
): ResolvedLayout {
  const { width, height } = viewport;
  // Body padding (2 gaps) + the splitters next to the sidebar and between the
  // panes + the preview's own splitter while it is open.
  const fixed = 4 * GAP_PX + (prefs.previewOpen ? GAP_PX : 0);
  const panesMin = 2 * PANE_MIN_PX;

  // The preview may squeeze the sidebar down to its minimum, not further.
  const previewMax = Math.max(
    PREVIEW_MIN_WIDTH,
    Math.min(
      Math.floor(width * PREVIEW_MAX_FRACTION),
      width - fixed - panesMin - SIDEBAR_MIN_WIDTH,
    ),
  );
  const previewWidth = clamp(prefs.previewWidth, PREVIEW_MIN_WIDTH, previewMax);
  const preview = prefs.previewOpen ? previewWidth : 0;

  const sidebarMax = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, width - fixed - panesMin - preview),
  );
  const sidebar = clamp(prefs.sidebarWidth, SIDEBAR_MIN_WIDTH, sidebarMax);

  const panesTotal = Math.max(panesMin, width - fixed - sidebar - preview);
  const localLimits = { min: PANE_MIN_PX, max: panesTotal - PANE_MIN_PX };
  const local = clamp(
    Math.round(prefs.panesRatio * panesTotal),
    localLimits.min,
    localLimits.max,
  );

  const transfersMax = Math.max(
    TRANSFERS_MIN_HEIGHT,
    Math.floor(height * TRANSFERS_MAX_FRACTION) - TRANSFERS_HEADER_PX,
  );
  const transfers = clamp(
    prefs.transfersHeight,
    TRANSFERS_MIN_HEIGHT,
    transfersMax,
  );

  return {
    sidebar,
    preview,
    previewWidth,
    local,
    remote: panesTotal - local,
    panesTotal,
    ratio: local / panesTotal,
    transfers,
    limits: {
      sidebar: { min: SIDEBAR_MIN_WIDTH, max: sidebarMax },
      preview: { min: PREVIEW_MIN_WIDTH, max: previewMax },
      local: localLimits,
      transfers: { min: TRANSFERS_MIN_HEIGHT, max: transfersMax },
    },
  };
}

/** The CSS custom properties the shell reads (set on the layout container). */
export function layoutVars(layout: ResolvedLayout): Record<string, string> {
  // Whole-number weights: flex-grow shares the row in this proportion.
  const localGrow = Math.round(layout.ratio * 1000);
  return {
    "--sidebar-w": `${layout.sidebar}px`,
    "--preview-w": `${layout.previewWidth}px`,
    "--pane-local-grow": String(localGrow),
    "--pane-remote-grow": String(1000 - localGrow),
    "--transfers-list-h": `${layout.transfers}px`,
  };
}
