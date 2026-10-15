/**
 * Saved connections, mirrored from the backend. Every mutation calls the IPC
 * command and then re-reads the list (`profiles:changed` also triggers a
 * refresh via `useCoreEvents`), so the store never guesses.
 */

import { create } from "zustand";

import {
  deleteProfile,
  listProfiles,
  saveProfile,
  toIpcError,
} from "../ipc/commands";
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ProfileId,
} from "../ipc/types";
import { toastError } from "./toastStore";

interface ProfilesState {
  profiles: ConnectionProfile[];
  /** False until the first successful load (shows a loading state). */
  loaded: boolean;
  /** Re-read the list; a failure toasts and keeps the current list. */
  refresh: () => Promise<void>;
  /** Create or replace; rejects with the `IpcError` for the form to show. */
  save: (input: ConnectionProfileInput) => Promise<ConnectionProfile>;
  /** Delete; rejects with the `IpcError` for the caller to show. */
  remove: (id: ProfileId) => Promise<void>;
}

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  profiles: [],
  loaded: false,
  refresh: async () => {
    try {
      const profiles = await listProfiles();
      set({ profiles, loaded: true });
    } catch (e) {
      toastError("Could not load connections", toIpcError(e).message);
    }
  },
  save: async (input) => {
    const saved = await saveProfile(input);
    await get().refresh();
    return saved;
  },
  remove: async (id) => {
    await deleteProfile(id);
    await get().refresh();
  },
}));
