/**
 * Persistent shell layout: the sizes of the resizable islands (sidebar width,
 * Local/Remote split, preview width, transfer list height), the collapse
 * state of the transfer and preview islands, and which connections in the
 * sidebar have their favorites folded away (expanded by default).
 *
 * The sizes are preferences, clamped here to their absolute bounds only; the
 * window-dependent limits are applied when drawing (`lib/resize`). Saved
 * layouts are merged over the defaults, so a key an older version did not
 * write simply means its default.
 */

import { create } from "zustand";

import {
  PANES_DEFAULT_RATIO,
  PANES_RATIO_MAX,
  PANES_RATIO_MIN,
  PREVIEW_DEFAULT_WIDTH,
  PREVIEW_MIN_WIDTH,
  PREVIEW_STORED_MAX,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  TRANSFERS_DEFAULT_HEIGHT,
  TRANSFERS_MIN_HEIGHT,
  TRANSFERS_STORED_MAX,
  clamp,
  finiteOr,
  type LayoutPrefs,
} from "../lib/resize";

const STORAGE_KEY = "iris.layout";

/** What is saved: the island sizes plus the sidebar's folded connections. */
interface StoredLayout extends LayoutPrefs {
  /** Profile ids whose favorites the sidebar hides. */
  collapsedFavorites: string[];
}

const DEFAULTS: StoredLayout = {
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  panesRatio: PANES_DEFAULT_RATIO,
  previewWidth: PREVIEW_DEFAULT_WIDTH,
  previewOpen: true,
  transfersHeight: TRANSFERS_DEFAULT_HEIGHT,
  transfersCollapsed: false,
  collapsedFavorites: [],
};

const clampSidebar = (v: number) =>
  clamp(v, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
const clampRatio = (v: number) => clamp(v, PANES_RATIO_MIN, PANES_RATIO_MAX);
const clampPreview = (v: number) =>
  clamp(v, PREVIEW_MIN_WIDTH, PREVIEW_STORED_MAX);
const clampTransfers = (v: number) =>
  clamp(v, TRANSFERS_MIN_HEIGHT, TRANSFERS_STORED_MAX);

function load(): StoredLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<StoredLayout> | null;
    if (!saved || typeof saved !== "object") return { ...DEFAULTS };
    return {
      sidebarWidth: clampSidebar(
        finiteOr(saved.sidebarWidth, DEFAULTS.sidebarWidth),
      ),
      panesRatio: clampRatio(finiteOr(saved.panesRatio, DEFAULTS.panesRatio)),
      previewWidth: clampPreview(
        finiteOr(saved.previewWidth, DEFAULTS.previewWidth),
      ),
      previewOpen: saved.previewOpen !== false,
      transfersHeight: clampTransfers(
        finiteOr(saved.transfersHeight, DEFAULTS.transfersHeight),
      ),
      transfersCollapsed: saved.transfersCollapsed === true,
      collapsedFavorites: Array.isArray(saved.collapsedFavorites)
        ? saved.collapsedFavorites.filter((id) => typeof id === "string")
        : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(state: StoredLayout) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sidebarWidth: state.sidebarWidth,
        panesRatio: state.panesRatio,
        previewWidth: state.previewWidth,
        previewOpen: state.previewOpen,
        transfersHeight: state.transfersHeight,
        transfersCollapsed: state.transfersCollapsed,
        collapsedFavorites: state.collapsedFavorites,
      }),
    );
  } catch {
    /* quota exceeded */
  }
}

interface LayoutState extends StoredLayout {
  setSidebarWidth: (width: number) => void;
  setPanesRatio: (ratio: number) => void;
  setPreviewWidth: (width: number) => void;
  setTransfersHeight: (height: number) => void;
  setTransfersCollapsed: (collapsed: boolean) => void;
  setPreviewOpen: (open: boolean) => void;
  togglePreview: () => void;
  /** Show (`true`) or fold away a connection's favorites in the sidebar. */
  setFavoritesExpanded: (profileId: string, expanded: boolean) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  const update = (patch: Partial<StoredLayout>) => {
    set(patch);
    persist(get());
  };
  return {
    ...load(),
    setSidebarWidth: (width) => update({ sidebarWidth: clampSidebar(width) }),
    setPanesRatio: (ratio) => update({ panesRatio: clampRatio(ratio) }),
    setPreviewWidth: (width) => update({ previewWidth: clampPreview(width) }),
    setTransfersHeight: (height) =>
      update({ transfersHeight: clampTransfers(height) }),
    setTransfersCollapsed: (collapsed) =>
      update({ transfersCollapsed: collapsed }),
    setPreviewOpen: (open) => update({ previewOpen: open }),
    togglePreview: () => update({ previewOpen: !get().previewOpen }),
    setFavoritesExpanded: (profileId, expanded) => {
      const rest = get().collapsedFavorites.filter((id) => id !== profileId);
      update({ collapsedFavorites: expanded ? rest : [...rest, profileId] });
    },
  };
});
