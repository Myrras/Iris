/** Persistent shell layout: sidebar width and the transfer panel's collapse. */

import { create } from "zustand";

interface LayoutPersisted {
  sidebarWidth: number;
  /** Whether the bottom transfer island is collapsed to its header. */
  transfersCollapsed: boolean;
}

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 600;

const STORAGE_KEY = "iris.layout";

const DEFAULTS: LayoutPersisted = {
  sidebarWidth: 280,
  transfersCollapsed: false,
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
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(state: LayoutPersisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota exceeded */
  }
}

interface LayoutState extends LayoutPersisted {
  setSidebarWidth: (width: number) => void;
  setTransfersCollapsed: (collapsed: boolean) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  ...load(),
  setSidebarWidth: (width) => {
    set({ sidebarWidth: clampWidth(width) });
    persist({
      sidebarWidth: get().sidebarWidth,
      transfersCollapsed: get().transfersCollapsed,
    });
  },
  setTransfersCollapsed: (collapsed) => {
    set({ transfersCollapsed: collapsed });
    persist({
      sidebarWidth: get().sidebarWidth,
      transfersCollapsed: collapsed,
    });
  },
}));
