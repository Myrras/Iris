/**
 * Favorite folders: the Local list (app-wide, in the core's settings) and
 * one list per saved connection (on its profile). The core is the source of
 * truth; `backendSettingsStore` / `profilesStore` mirror it and every change
 * goes through their `setLocalFavorites` / `setFavorites` (applied at once,
 * sent, re-read; a refusal toasts and puts the backend's list back).
 *
 * - The star in a pane's path bar and the folder rows' context menu add or
 *   remove a folder (`toggleFavorite`, `addFavorite`, `removeFavorite`).
 * - The sidebar lists them (`FavoriteList`): a click opens the folder in the
 *   pane's active tab, ⌘-click (Ctrl-click off macOS) in a new tab. A remote
 *   favorite first makes its connection the active one, connecting it when
 *   it has no session (`openConnection`); nothing navigates when that fails
 *   or is cancelled. A folder that is gone gives the usual navigation error
 *   and the favorite stays.
 */

import { homeDir, toIpcError } from "../ipc/commands";
import type { ConnectionProfile, Favorite, ProfileId } from "../ipc/types";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { usePaneStore, type PaneId } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { toastError } from "../state/toastStore";
import { useTabsStore } from "../state/tabsStore";
import { openConnection } from "./connect";
import { baseName } from "./path";
import { isMac } from "./platform";

/** Which list: the Local one, or one connection's. */
export type FavoriteScope =
  { kind: "local" } | { kind: "remote"; profileId: ProfileId };

export const LOCAL_FAVORITES: FavoriteScope = { kind: "local" };

const EMPTY: Favorite[] = [];

/**
 * The name a favorite shows: its label, else the folder's name (Local) or
 * the whole path (Remote, where several servers share names like `www`).
 */
export function favoriteLabel(fav: Favorite, scope: FavoriteScope): string {
  if (fav.label) return fav.label;
  return scope.kind === "local" ? baseName(fav.path) : fav.path;
}

/** ⌘-click on macOS, Ctrl-click elsewhere: open in a new tab. */
export function wantsNewTab(e: { metaKey: boolean; ctrlKey: boolean }) {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** The list as the stores have it now (empty while not loaded). */
export function favoritesOf(scope: FavoriteScope): Favorite[] {
  if (scope.kind === "local") {
    return useBackendSettingsStore.getState().settings?.localFavorites ?? EMPTY;
  }
  return (
    useProfilesStore.getState().profiles.find((p) => p.id === scope.profileId)
      ?.favorites ?? EMPTY
  );
}

/** A component's live view of a list. */
export function useFavorites(scope: FavoriteScope | null): Favorite[] {
  const local = useBackendSettingsStore((s) => s.settings?.localFavorites);
  const remote = useProfilesStore((s) =>
    scope?.kind === "remote"
      ? s.profiles.find((p) => p.id === scope.profileId)?.favorites
      : undefined,
  );
  if (!scope) return EMPTY;
  return (scope.kind === "local" ? local : remote) ?? EMPTY;
}

export const isFavorite = (list: Favorite[], path: string) =>
  list.some((f) => f.path === path);

/**
 * The list to change, read from the backend first when the Local one was
 * never loaded (writing without it would drop what is stored). `null` when
 * it could not be read (already reported).
 */
async function current(scope: FavoriteScope): Promise<Favorite[] | null> {
  if (scope.kind === "local" && !useBackendSettingsStore.getState().settings) {
    await useBackendSettingsStore.getState().load();
    if (!useBackendSettingsStore.getState().settings) return null;
  }
  return favoritesOf(scope);
}

/** Store `list` as the scope's favorites; resolves whether it was stored. */
function write(
  scope: FavoriteScope,
  list: Favorite[],
  failure: string,
): Promise<boolean> {
  return scope.kind === "local"
    ? useBackendSettingsStore.getState().setLocalFavorites(list, failure)
    : useProfilesStore.getState().setFavorites(scope.profileId, list, failure);
}

/** Add `path` at the end of the list (nothing when it is there already). */
export async function addFavorite(
  scope: FavoriteScope,
  path: string,
): Promise<void> {
  const list = await current(scope);
  if (!list || isFavorite(list, path)) return;
  await write(
    scope,
    [...list, { path, label: null }],
    "Could not add the favorite",
  );
}

export async function removeFavorite(
  scope: FavoriteScope,
  path: string,
): Promise<void> {
  const list = await current(scope);
  if (!list || !isFavorite(list, path)) return;
  await write(
    scope,
    list.filter((f) => f.path !== path),
    "Could not remove the favorite",
  );
}

/** The star: add the folder, or remove it when it is a favorite. */
export async function toggleFavorite(
  scope: FavoriteScope,
  path: string,
): Promise<void> {
  const list = await current(scope);
  if (!list) return;
  if (isFavorite(list, path)) await removeFavorite(scope, path);
  else await addFavorite(scope, path);
}

/** Give a favorite a label; blank = derived from the path again. */
export async function renameFavorite(
  scope: FavoriteScope,
  path: string,
  label: string,
): Promise<void> {
  const list = await current(scope);
  const fav = list?.find((f) => f.path === path);
  if (!list || !fav) return;
  const next = label.trim() || null;
  if (next === fav.label) return;
  await write(
    scope,
    list.map((f) => (f.path === path ? { ...f, label: next } : f)),
    "Could not rename the favorite",
  );
}

/** Put the list in a new order (a drag). */
export async function reorderFavorites(
  scope: FavoriteScope,
  list: Favorite[],
): Promise<void> {
  await write(scope, list, "Could not reorder the favorites");
}

/**
 * Show `path` in `pane`: navigate (Back works) when the pane has a folder,
 * else open it there (the pane is still opening its first folder, which
 * this supersedes).
 */
function goToFolder(pane: PaneId, path: string): void {
  const panes = usePaneStore.getState();
  const { target, path: shown } = panes.panes[pane];
  if (!target) return;
  panes.setActive(pane);
  if (shown !== null) void panes.navigate(pane, path);
  else void panes.open(pane, target, path);
}

/** Open a Local favorite in the active Local tab, or in a new one. */
export function openLocalFavorite(path: string, newTab: boolean): void {
  if (newTab) {
    useTabsStore.getState().newTab("local", path);
    usePaneStore.getState().setActive("local");
  } else {
    goToFolder("local", path);
  }
}

/** The sidebar's Home row: the local home folder. */
export async function openLocalHome(newTab: boolean): Promise<void> {
  try {
    openLocalFavorite(await homeDir({ kind: "local" }), newTab);
  } catch (e) {
    toastError("Could not open the home folder", toIpcError(e).message);
  }
}

/**
 * Open `path` of `profile`'s connection: make it the active one (connecting
 * it when it has no session), then show the folder in its active Remote tab
 * or a new one. Nothing navigates when the connect fails or is cancelled,
 * or the user picked another connection meanwhile.
 */
export async function openRemoteFavorite(
  profile: ConnectionProfile,
  path: string,
  newTab: boolean,
): Promise<void> {
  await openConnection(profile);
  const tabs = useTabsStore.getState();
  if (tabs.activeProfileId !== profile.id) return;
  if (!tabs.connections[profile.id]?.sessionId) return;
  if (newTab) {
    tabs.newTab("remote", path);
    usePaneStore.getState().setActive("remote");
  } else {
    goToFolder("remote", path);
  }
}
