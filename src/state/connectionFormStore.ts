/**
 * Which connection the form dialog edits. Opened from several places (the
 * sidebar footer, a row's context menu, the welcome screen), rendered once.
 */

import { create } from "zustand";

import type { ConnectionProfile } from "../ipc/types";

interface ConnectionFormState {
  open: boolean;
  /** The profile being edited; `null` for a new connection. */
  editing: ConnectionProfile | null;
  openNew: () => void;
  openEdit: (profile: ConnectionProfile) => void;
  close: () => void;
}

export const useConnectionFormStore = create<ConnectionFormState>((set) => ({
  open: false,
  editing: null,
  openNew: () => set({ open: true, editing: null }),
  openEdit: (profile) => set({ open: true, editing: profile }),
  close: () => set({ open: false }),
}));
