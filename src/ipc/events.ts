/**
 * Typed wrappers over the global Tauri events emitted by `src-tauri`
 * (`events.rs` forwards core events; `lib.rs` emits the window/menu ones).
 * Events only say *what* changed — handlers re-pull data through `commands.ts`.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { HostKeyPromptEvent, SessionStateChangedEvent } from "./types";

/** The persisted backend settings changed; re-pull them via `getSettings`. */
export function onSettingsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("settings:changed", () => handler());
}

/** The saved connections changed; re-pull them via `listProfiles`. */
export function onProfilesChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("profiles:changed", () => handler());
}

/**
 * A connect hit an unknown host key and waits for
 * `answerHostKey(requestId, trust)`. If the session turns `disconnected`
 * first (e.g. the prompt timed out), close the prompt.
 */
export function onHostKeyPrompt(
  handler: (event: HostKeyPromptEvent) => void,
): Promise<UnlistenFn> {
  return listen<HostKeyPromptEvent>("session:host-key-prompt", (e) =>
    handler(e.payload),
  );
}

/** A session became `connecting`, `connected` or `disconnected`. */
export function onSessionStateChanged(
  handler: (event: SessionStateChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionStateChangedEvent>("session:state-changed", (e) =>
    handler(e.payload),
  );
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
