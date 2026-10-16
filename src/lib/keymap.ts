/**
 * The keyboard map: named actions with their default bindings, a matcher for
 * key events, and the display format.
 *
 * A binding is a string such as `"Mod+Shift+KeyN"`: `Mod` is Cmd on macOS and
 * Ctrl elsewhere, the last part is the key. Letters and digits are matched by
 * the character they type (so Dvorak, AZERTY and Cyrillic layouts keep Cmd+P
 * on P), everything else and every Option/Alt combination by the physical
 * `code` (Option+S types "ß" on a Mac, so its `key` says nothing).
 *
 * Settings → Shortcuts stores only the bindings the user changed
 * (`settingsStore.shortcuts`); `resolveKeymap` lays them over the defaults,
 * so an action added later still gets its default. Enter, Space, the arrow
 * keys, F5 and Cmd+O / Cmd+Down / Cmd+Up stay fixed (`RESERVED`).
 *
 * Pure rules, no React: `Pane.tsx` and `useTabShortcuts.ts` dispatch with
 * `findAction`.
 */

import { isMac } from "./platform";

export type ActionId =
  | "goTo"
  | "refresh"
  | "find"
  | "newFolder"
  | "rename"
  | "delete"
  | "getInfo"
  | "upload"
  | "download"
  | "sync"
  | "openInEditor"
  | "showInFinder"
  | "togglePreview"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "openSettings";

/** `pane`: handled by the focused / active file pane; `app`: window-wide. */
export type ActionScope = "pane" | "app";

export type ActionGroup = "Navigate" | "Files" | "Transfers" | "View" | "Tabs";

export interface ActionDef {
  id: ActionId;
  label: string;
  group: ActionGroup;
  scope: ActionScope;
  defaults: string[];
  /** What else triggers it, shown under the row (the fixed keys). */
  note?: string;
  /** macOS only: the native menu owns it, so it is neither bound nor listed. */
  windowsLinuxOnly?: boolean;
}

export const ACTIONS: ActionDef[] = [
  {
    id: "goTo",
    label: "Go to path",
    group: "Navigate",
    scope: "pane",
    defaults: ["Mod+KeyP", "Mod+KeyL"],
  },
  {
    id: "refresh",
    label: "Refresh",
    group: "Navigate",
    scope: "pane",
    defaults: ["Mod+KeyR"],
  },
  {
    id: "find",
    label: "Find (filter)",
    group: "Navigate",
    scope: "pane",
    defaults: ["Mod+KeyF"],
  },
  {
    id: "newFolder",
    label: "New folder",
    group: "Files",
    scope: "pane",
    defaults: ["Mod+Shift+KeyN"],
  },
  {
    id: "rename",
    label: "Rename",
    group: "Files",
    scope: "pane",
    defaults: ["F2"],
    note: "Enter also renames on macOS.",
  },
  {
    id: "delete",
    label: "Delete",
    group: "Files",
    scope: "pane",
    defaults: ["Delete", "Mod+Backspace"],
  },
  {
    id: "getInfo",
    label: "Get Info",
    group: "Files",
    scope: "pane",
    defaults: ["Mod+KeyI"],
  },
  {
    id: "openInEditor",
    label: "Open in editor",
    group: "Files",
    scope: "pane",
    defaults: ["Mod+KeyE"],
    note: "Remote files only.",
  },
  {
    id: "showInFinder",
    label: "Show in Finder / Explorer",
    group: "Files",
    scope: "pane",
    defaults: ["Mod+Alt+KeyR"],
    note: "Local files only.",
  },
  {
    id: "upload",
    label: "Upload",
    group: "Transfers",
    scope: "pane",
    defaults: ["Mod+Shift+KeyU"],
    note: "From the Local pane. F5 copies to the other pane.",
  },
  {
    id: "download",
    label: "Download",
    group: "Transfers",
    scope: "pane",
    defaults: ["Mod+Shift+KeyD"],
    note: "From the Remote pane. F5 copies to the other pane.",
  },
  {
    id: "sync",
    label: "Sync folders",
    group: "Transfers",
    scope: "pane",
    defaults: ["Mod+Alt+KeyS"],
  },
  {
    id: "togglePreview",
    label: "Toggle preview",
    group: "View",
    scope: "pane",
    defaults: ["Mod+Alt+KeyP"],
    note: "Space also toggles it.",
  },
  {
    id: "newTab",
    label: "New tab",
    group: "Tabs",
    scope: "app",
    defaults: ["Mod+KeyT"],
  },
  {
    id: "closeTab",
    label: "Close tab",
    group: "Tabs",
    scope: "app",
    defaults: ["Mod+KeyW"],
  },
  {
    id: "nextTab",
    label: "Next tab",
    group: "Tabs",
    scope: "app",
    defaults: ["Mod+Shift+BracketRight"],
    note: "Cmd/Ctrl+1 to 9 switch to a tab.",
  },
  {
    id: "prevTab",
    label: "Previous tab",
    group: "Tabs",
    scope: "app",
    defaults: ["Mod+Shift+BracketLeft"],
  },
  {
    id: "openSettings",
    label: "Open Settings",
    group: "View",
    scope: "app",
    defaults: ["Mod+Comma"],
    windowsLinuxOnly: true,
  },
];

export const GROUPS: ActionGroup[] = [
  "Navigate",
  "Files",
  "Transfers",
  "View",
  "Tabs",
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function actionDef(id: ActionId): ActionDef {
  return BY_ID.get(id)!;
}

/** The actions shown and bound on this platform. */
export function activeActions(mac: boolean = isMac): ActionDef[] {
  return ACTIONS.filter((a) => !(mac && a.windowsLinuxOnly));
}

// -- Bindings -----------------------------------------------------------------

export interface Binding {
  /** `KeyP`, `Digit1`, `F2`, `Delete`, `BracketLeft`, … */
  code: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "AltGraph"]);

export function parseBinding(text: string): Binding | null {
  const parts = text.split("+");
  const code = parts.pop();
  if (!code) return null;
  const b: Binding = { code, mod: false, shift: false, alt: false };
  for (const part of parts) {
    if (part === "Mod") b.mod = true;
    else if (part === "Shift") b.shift = true;
    else if (part === "Alt") b.alt = true;
    else return null;
  }
  return /^[A-Za-z][A-Za-z0-9]*$/.test(code) ? b : null;
}

export function serializeBinding(b: Binding): string {
  return [
    ...(b.mod ? ["Mod"] : []),
    ...(b.alt ? ["Alt"] : []),
    ...(b.shift ? ["Shift"] : []),
    b.code,
  ].join("+");
}

/** The parts of a key event the keymap reads (DOM and React events fit). */
export interface KeyEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Keys whose `code` the browser may leave empty (synthetic events). */
const CODE_BY_KEY: Record<string, string> = {
  " ": "Space",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

/** The key of an event as binding code, or null for a bare modifier. */
export function codeOf(e: KeyEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  // user-event and some IMEs report "Unknown" or nothing.
  const code = e.code && e.code !== "Unknown" ? e.code : "";
  // Option changes the character (Option+S → "ß"): trust the physical key.
  if (!e.altKey || !code) {
    if (/^[a-z]$/i.test(e.key)) return `Key${e.key.toUpperCase()}`;
    if (/^[0-9]$/.test(e.key) && !e.shiftKey) return `Digit${e.key}`;
  }
  if (code) return code;
  if (e.key.length > 1 && e.key !== "Dead" && e.key !== "Unidentified") {
    return e.key;
  }
  return CODE_BY_KEY[e.key] ?? null;
}

function modifiers(e: KeyEventLike, mac: boolean) {
  return {
    mod: mac ? e.metaKey : e.ctrlKey,
    // The other one (Ctrl on a Mac, the Windows key elsewhere) is never part
    // of a binding, so holding it never matches.
    stray: mac ? e.ctrlKey : e.metaKey,
  };
}

export function matches(
  e: KeyEventLike,
  binding: string | Binding,
  mac: boolean = isMac,
): boolean {
  const b = typeof binding === "string" ? parseBinding(binding) : binding;
  if (!b) return false;
  const { mod, stray } = modifiers(e, mac);
  return (
    !stray &&
    mod === b.mod &&
    e.shiftKey === b.shift &&
    e.altKey === b.alt &&
    codeOf(e) === b.code
  );
}

/** The binding a key press spells out, or null for a bare modifier. */
export function bindingFromEvent(
  e: KeyEventLike,
  mac: boolean = isMac,
): Binding | null {
  const code = codeOf(e);
  if (!code) return null;
  const { mod, stray } = modifiers(e, mac);
  // Ctrl on a Mac (or the Windows key) is not one of our modifiers.
  if (stray) return null;
  return { code, mod, shift: e.shiftKey, alt: e.altKey };
}

// -- Keymap -------------------------------------------------------------------

export type Keymap = Record<ActionId, string[]>;

/** What the user changed: the whole list of bindings for an action. */
export type ShortcutOverrides = Partial<Record<ActionId, string[]>>;

export const DEFAULT_KEYMAP = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.defaults]),
) as Keymap;

/**
 * The defaults with the user's changes laid over them. Unknown actions and
 * unreadable or empty lists are dropped, so a stale blob cannot unbind
 * anything.
 */
export function resolveKeymap(overrides?: unknown): Keymap {
  const saved = (overrides ?? {}) as Record<string, unknown>;
  const map = { ...DEFAULT_KEYMAP };
  for (const a of ACTIONS) {
    const list = saved[a.id];
    if (
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((b) => typeof b === "string" && parseBinding(b) !== null)
    ) {
      map[a.id] = list as string[];
    }
  }
  return map;
}

/** The first action of `scope` whose binding the event matches. */
export function findAction(
  e: KeyEventLike,
  keymap: Keymap,
  scope: ActionScope,
  mac: boolean = isMac,
): ActionId | null {
  for (const a of activeActions(mac)) {
    if (a.scope !== scope) continue;
    if (keymap[a.id].some((b) => matches(e, b, mac))) return a.id;
  }
  return null;
}

// -- Rules for what can be bound ---------------------------------------------

/** Keys that are not rebindable, with what they do (Mod = Cmd / Ctrl). */
const RESERVED: [string, string][] = [
  ["Mod+KeyA", "Select all"],
  ["Mod+KeyC", "Copy"],
  ["Mod+KeyV", "Paste"],
  ["Mod+KeyX", "Cut"],
  ["Mod+KeyZ", "Undo"],
  ["Mod+Shift+KeyZ", "Redo"],
  ["Mod+KeyO", "Open"],
  ["Mod+ArrowDown", "Open"],
  ["Mod+ArrowUp", "Enclosing folder"],
  ["F5", "Copy to the other pane"],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [string, string] => [
    `Mod+Digit${n}`,
    "Switch tab",
  ]),
];

const RESERVED_MAC: [string, string][] = [
  ["Mod+Comma", "Settings"],
  ["Mod+KeyQ", "Quit"],
  ["Mod+KeyH", "Hide"],
  ["Mod+Alt+KeyH", "Hide others"],
  ["Mod+KeyM", "Minimize"],
];

const RESERVED_OTHER: [string, string][] = [["Alt+F4", "Close the window"]];

function isFunctionKey(code: string): boolean {
  return /^F([1-9]|1[0-2])$/.test(code);
}

/**
 * Why a binding cannot be used at all, or null. A bare printable key would
 * fight type-to-select, so it needs Cmd/Ctrl or Option/Alt; function keys and
 * Delete may stand alone.
 */
export function bindingProblem(
  b: Binding,
  mac: boolean = isMac,
): string | null {
  if (b.code === "Escape") return "Escape closes dialogs and cannot be bound.";
  const bare = !b.mod && !b.alt;
  if (bare && !isFunctionKey(b.code) && b.code !== "Delete") {
    return `Hold ${mac ? "⌘ or ⌥" : "Ctrl or Alt"} as well.`;
  }
  const text = serializeBinding(b);
  const reserved = [...RESERVED, ...(mac ? RESERVED_MAC : RESERVED_OTHER)].find(
    ([r]) => r === text,
  );
  if (reserved) {
    return `${formatBinding(b, mac)} is fixed (${reserved[1]}).`;
  }
  return null;
}

/** The action (other than `action`) that already uses the binding. */
export function findConflict(
  keymap: Keymap,
  action: ActionId,
  binding: Binding,
  mac: boolean = isMac,
): ActionId | null {
  const text = serializeBinding(binding);
  for (const a of activeActions(mac)) {
    if (a.id !== action && keymap[a.id].includes(text)) return a.id;
  }
  return null;
}

// -- Display ------------------------------------------------------------------

const SYMBOLS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function keyLabel(code: string, mac: boolean): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code in SYMBOLS) return SYMBOLS[code];
  if (mac && code === "Backspace") return "⌫";
  if (mac && code === "Delete") return "⌦";
  if (mac && code === "Enter") return "↩";
  return code;
}

/** `⇧⌘G` on a Mac, `Ctrl+Shift+G` elsewhere. */
export function formatBinding(
  binding: string | Binding,
  mac: boolean = isMac,
): string {
  const b = typeof binding === "string" ? parseBinding(binding) : binding;
  if (!b) return "";
  const key = keyLabel(b.code, mac);
  if (mac) {
    return `${b.alt ? "⌥" : ""}${b.shift ? "⇧" : ""}${b.mod ? "⌘" : ""}${key}`;
  }
  return [
    ...(b.mod ? ["Ctrl"] : []),
    ...(b.alt ? ["Alt"] : []),
    ...(b.shift ? ["Shift"] : []),
    key,
  ].join("+");
}

/** The action's first binding for a tooltip or menu hint; "" if unbound. */
export function shortcutHint(
  keymap: Keymap,
  action: ActionId,
  mac: boolean = isMac,
): string {
  const [first] = keymap[action];
  return first ? formatBinding(first, mac) : "";
}

/** `"Refresh"` + `"⌘R"` → `"Refresh (⌘R)"`. */
export function withHint(
  title: string,
  keymap: Keymap,
  action: ActionId,
  mac: boolean = isMac,
): string {
  const hint = shortcutHint(keymap, action, mac);
  return hint ? `${title} (${hint})` : title;
}

/** The tooltip for Toggle preview: its binding, then the fixed Space. */
export function previewTitle(
  verb: string,
  keymap: Keymap,
  mac: boolean = isMac,
): string {
  const keys = [shortcutHint(keymap, "togglePreview", mac), "Space"];
  return `${verb} (${keys.filter(Boolean).join(" or ")})`;
}

// -- Event helpers --------------------------------------------------------------

/** Typing in a field (filter, rename, dialogs) never triggers shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

/**
 * Browser shortcuts a desktop app must never act on: reload (F5, Cmd/Ctrl+R,
 * also with Shift), print, find-in-page, save and "find again". Dev builds of
 * Tauri / WebKit reload on Cmd+R, WebView2 prints on Ctrl+P. Swallowed even
 * when unbound, so rebinding Go to path away from Cmd+P does not bring the
 * print dialog back.
 */
export function isBrowserShortcut(
  e: KeyEventLike,
  mac: boolean = isMac,
): boolean {
  if (e.key === "F5") return true;
  const { mod } = modifiers(e, mac);
  if (!mod || e.altKey) return false;
  return ["KeyR", "KeyP", "KeyF", "KeyG", "KeyS"].includes(codeOf(e) ?? "");
}
