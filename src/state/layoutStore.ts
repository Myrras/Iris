/**
 * Persistent shell layout: sidebar width, the transfer panel's collapse and
 * whether the preview island is open.
 */

import { create } from "zustand";

interface LayoutPersisted {
  sidebarWidth: number;
  /** Whether the bottom transfer island is collapsed to its header. */
  transfersCollapsed: boolean;
  /** Whether the preview island right of the panes is expanded. */
  previewOpen: boolean;
}

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 600;

const STORAGE_KEY = "iris.layout";

const DEFAULTS: LayoutPersisted = {
  sidebarWidth: 280,
  transfersCollapsed: false,
  previewOpen: true,
};

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function load(): LayoutPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<LayoutPersisted>;
    return {
      sidebarWidth:
        typeof saved.sidebarWidth === "number"
          ? clampWidth(saved.sidebarWidth)
          : DEFAULTS.sidebarWidth,
      transfersCollapsed: saved.transfersCollapsed === true,
      previewOpen: saved.previewOpen !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(state: LayoutPersisted) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sidebarWidth: state.sidebarWidth,
        transfersCollapsed: state.transfersCollapsed,
        previewOpen: state.previewOpen,
      }),
    );
  } catch {
    /* quota exceeded */
  }
}

interface LayoutState extends LayoutPersisted {
  setSidebarWidth: (width: number) => void;
  setTransfersCollapsed: (collapsed: boolean) => void;
  setPreviewOpen: (open: boolean) => void;
  togglePreview: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  const update = (patch: Partial<LayoutPersisted>) => {
    set(patch);
    persist(get());
  };
  return {
    ...load(),
    setSidebarWidth: (width) => update({ sidebarWidth: clampWidth(width) }),
    setTransfersCollapsed: (collapsed) =>
      update({ transfersCollapsed: collapsed }),
    setPreviewOpen: (open) => update({ previewOpen: open }),
    togglePreview: () => update({ previewOpen: !get().previewOpen }),
  };
});
