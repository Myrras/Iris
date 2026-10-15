/**
 * Typed wrappers over the global Tauri events emitted by `src-tauri`
 * (`events.rs` forwards core events; `lib.rs` emits the window/menu ones).
 * Events only say *what* changed — handlers re-pull data through `commands.ts`.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The persisted backend settings changed; re-pull them via `getSettings`. */
export function onSettingsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("settings:changed", () => handler());
}

/** The native macOS menu's Settings… item (⌘,) was activated (`lib.rs`). */
export function onMenuOpenSettings(handler: () => void): Promise<UnlistenFn> {
  return listen("menu:open-settings", () => handler());
}

/**
 * A close/quit was blocked because the core still has active work
 * (`lib.rs`). The frontend responds by showing the close-warning dialog.
 */
export function onWindowCloseRequested(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("window:close-requested", () => handler());
}
