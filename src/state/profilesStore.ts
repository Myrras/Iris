/**
 * Saved connections, mirrored from the backend. Every mutation calls the IPC
 * command and then re-reads the list (`profiles:changed` also triggers a
 * refresh via `useCoreEvents`), so the store never guesses.
 */

import { create } from "zustand";

import {
  deleteProfile,
  listProfiles,
  reorderProfiles,
  saveProfile,
  setProfileFavorites,
  toIpcError,
} from "../ipc/commands";
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  Favorite,
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
  /**
   * Put the connections in the order of `ids` (every saved id once). Applied
   * locally at once, then sent; either way the list is re-read afterwards.
   * A refusal toasts and puts the backend's order back, so it never rejects.
   */
  reorder: (ids: ProfileId[]) => Promise<void>;
  /** Delete; rejects with the `IpcError` for the caller to show. */
  remove: (id: ProfileId) => Promise<void>;
  /**
   * Replace a connection's favorite folders, like `reorder`: applied locally
   * at once, then sent, then the list is re-read. A refusal toasts with
   * `failure` as the title and puts the backend's list back; never rejects.
   * Resolves whether the backend stored it.
   */
  setFavorites: (
    id: ProfileId,
    favorites: Favorite[],
    failure: string,
  ) => Promise<boolean>;
}

/** The latest reorder; an older one that finishes late leaves the list alone. */
let reorderSeq = 0;
/** The latest favorites change per profile (same rule as `reorderSeq`). */
const favoritesSeq = new Map<ProfileId, number>();

const withFavorites = (
  profiles: ConnectionProfile[],
  id: ProfileId,
  favorites: Favorite[],
) => profiles.map((p) => (p.id === id ? { ...p, favorites } : p));

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
  reorder: async (ids) => {
    const previous = get().profiles;
    const byId = new Map(previous.map((p) => [p.id, p]));
    const local = ids.flatMap((id) => byId.get(id) ?? []);
    // Not a permutation of what is shown: the backend would refuse it too.
    const plausible = local.length === previous.length;
    const seq = ++reorderSeq;
    if (plausible) set({ profiles: local });
    try {
      await reorderProfiles(ids);
    } catch (e) {
      if (seq !== reorderSeq) return;
      set({ profiles: previous });
      toastError("Could not reorder connections", toIpcError(e).message);
    }
    if (seq === reorderSeq) await get().refresh();
  },
  remove: async (id) => {
    await deleteProfile(id);
    await get().refresh();
  },
  setFavorites: async (id, favorites, failure) => {
    const previous = get().profiles.find((p) => p.id === id)?.favorites ?? [];
    const seq = (favoritesSeq.get(id) ?? 0) + 1;
    favoritesSeq.set(id, seq);
    const latest = () => favoritesSeq.get(id) === seq;
    set({ profiles: withFavorites(get().profiles, id, favorites) });
    let stored = true;
    try {
      await setProfileFavorites(id, favorites);
    } catch (e) {
      stored = false;
      if (!latest()) return false;
      set({ profiles: withFavorites(get().profiles, id, previous) });
      toastError(failure, toIpcError(e).message);
    }
    if (latest()) await get().refresh();
    return stored;
  },
}));
