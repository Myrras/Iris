/**
 * Files and folders dragged in from Finder / Explorer upload when they are
 * dropped on the Remote pane (into its folder, or into the folder row under
 * the pointer). Subscribed once from `App`.
 *
 * The webview sees no DOM drag events for OS drags: Tauri's native handler
 * (`dragDropEnabled`, on by default) takes them and reports enter / over /
 * drop / leave with the pointer position and the local paths. The position
 * is hit-tested against the DOM (`document.elementFromPoint`); overlays shown
 * during the drag are `pointer-events: none`, so the test sees through them.
 *
 * Positions: Tauri types them as physical pixels, which they are on Windows
 * and Linux; on macOS wry reports AppKit points, which are already CSS
 * pixels, so only the other platforms divide by `devicePixelRatio`.
 */

import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import {
  dropTargetAt,
  useDragStore,
  type DropTarget,
} from "../state/dragStore";
import { usePaneStore } from "../state/paneStore";
import { toastInfo } from "../state/toastStore";
import { isMac } from "./platform";
import { remoteSessionId, startTransfer } from "./transfer";

/** The Remote-pane drop target under a native drag position, if any. */
export function nativeDropTarget(position: {
  x: number;
  y: number;
}): DropTarget | null {
  const scale = isMac ? 1 : window.devicePixelRatio || 1;
  const el = document.elementFromPoint(position.x / scale, position.y / scale);
  const over = dropTargetAt(el);
  return over?.pane === "remote" ? over : null;
}

export function useNativeDrop(): void {
  useEffect(() => {
    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      return; // no Tauri bridge (tests, plain browser)
    }
    const drag = useDragStore.getState;
    // Only a pane drag of our own sets `paneDrag`; never fight it.
    const sub = webview.onDragDropEvent(({ payload }) => {
      if (drag().paneDrag) return;
      switch (payload.type) {
        case "enter":
        case "over":
          drag().setNative(true, nativeDropTarget(payload.position));
          break;
        case "leave":
          drag().end();
          break;
        case "drop": {
          const over = nativeDropTarget(payload.position);
          drag().end();
          if (!over || payload.paths.length === 0) return;
          if (
            !remoteSessionId() ||
            !usePaneStore.getState().panes.remote.path
          ) {
            toastInfo("Connect to a server to upload");
            return;
          }
          void startTransfer("local", payload.paths, over.dir);
          break;
        }
      }
    });
    return () => {
      sub.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);
}
