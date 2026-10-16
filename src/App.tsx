/**
 * Iris — application shell (Podium's island layout).
 *
 * Layout: a slim title bar on the canvas; below it the sidebar island on the
 * left and the work column on the right — the Local and Remote pane islands
 * side by side with the collapsible preview island at their right, and the
 * collapsible transfer island underneath, with the tab strip above the
 * panes (each tab its own pane pair and session, `tabsStore`). This
 * component also owns the app-level wiring: the backend events
 * (`useCoreEvents`), files dragged in from the OS (`useNativeDrop`), the
 * pane-drag chip (`DragGhost`), the Sync dialog (`SyncDialog`), opening
 * the active tab's panes and the app shortcuts (`lib/keymap`), settings access (native menu on
 * macOS, title-bar gear elsewhere), the close-warning event, and suppressing
 * webview-only behaviour (reload shortcuts, the browser context menu).
 */

import { useCallback, useEffect, useState } from "react";

import { onMenuOpenSettings, onWindowCloseRequested } from "./ipc/events";
import { withHint } from "./lib/keymap";
import { isMac, isWindows } from "./lib/platform";
import { useCoreEvents } from "./lib/useCoreEvents";
import { useKeymap } from "./lib/useKeymap";
import { useNativeDrop } from "./lib/useNativeDrop";
import { useTabShortcuts } from "./lib/useTabShortcuts";
import { useLayoutStore } from "./state/layoutStore";
import { useTabsStore } from "./state/tabsStore";
import { useSettingsRequestStore } from "./state/settingsRequestStore";
import { CloseWarningModal } from "./components/CloseWarningModal";
import { ConnectionForm } from "./components/ConnectionForm";
import { DragGhost } from "./components/DragGhost";
import { LogoMark } from "./components/LogoMark";
import { Pane } from "./components/Pane";
import { PreviewPanel } from "./components/PreviewPanel";
import { PromptHost } from "./components/PromptHost";
import { SettingsModal } from "./components/SettingsModal";
import { SyncDialog } from "./components/SyncDialog";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TabCloseModal } from "./components/TabCloseModal";
import { Toasts } from "./components/Toasts";
import { TransferPanel } from "./components/TransferPanel";
import { WindowControls } from "./components/WindowControls";
import { LocalIcon, ServerIcon, SettingsIcon } from "./components/icons";
import styles from "./App.module.css";

export default function App() {
  useCoreEvents();
  useNativeDrop();
  const keymap = useKeymap();

  // Open the active tab's panes: the local pane in its restored folder (or
  // home), the remote pane only once the user connects (never on its own).
  useEffect(() => {
    useTabsStore.getState().showActive();
  }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Ctrl+, off macOS (rebindable); the browser shortcuts are swallowed there.
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  useTabShortcuts({ onOpenSettings: openSettings });
  const settingsRequest = useSettingsRequestStore((s) => s.request);
  useEffect(() => {
    if (settingsRequest) setSettingsOpen(true);
  }, [settingsRequest]);
  const [closeWarnOpen, setCloseWarnOpen] = useState(false);

  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);

  // The backend blocked a quit because work is still in flight — surface the
  // warning so the user can confirm or cancel.
  useEffect(() => {
    const sub = onWindowCloseRequested(() => setCloseWarnOpen(true));
    return () => {
      sub.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  const onSidebarResizerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      function onMove(ev: MouseEvent) {
        setSidebarWidth(startW + (ev.clientX - startX));
      }
      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      }
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth, setSidebarWidth],
  );

  // Suppress the webview's default right-click menu (the browser-y "Save as /
  // Print / Share" items, most glaring on Windows' WebView2). Kept inside
  // editable surfaces so native copy/paste still works there.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, [contenteditable=""], [contenteditable="true"]',
        )
      ) {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // macOS: the native menu's Settings… item (⌘,) emits `menu:open-settings`.
  // Elsewhere the shortcut comes from the keymap (`useTabShortcuts`), so
  // the two never double-fire.
  useEffect(() => {
    const menuSub = onMenuOpenSettings(() => setSettingsOpen(true));
    return () => {
      menuSub.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  return (
    <div className={styles.app}>
      <header
        className={`${styles.titlebar}${isWindows ? ` ${styles.titlebarWindows}` : ""}${isMac ? ` ${styles.titlebarMac}` : ""}`}
        // Windows has no native title bar (decorations: false) and macOS
        // overlays its traffic lights on our strip (titleBarStyle: Overlay) —
        // see CLAUDE.md's "Window chrome" — so the whole strip is the drag
        // handle on either. Linux keeps its native title bar for now.
        data-tauri-drag-region={isWindows || isMac ? true : undefined}
      >
        {/* macOS draws its own traffic lights top-left (.titlebarMac leaves
            room for them), so the brand is centered instead of leading. */}
        <div
          className={`${styles.brand}${isMac ? ` ${styles.brandCentered}` : ""}`}
        >
          <LogoMark size={18} className={styles.logo} aria-hidden />
          <span className={styles.product}>Iris</span>
          <span className={styles.tagline}>remote file manager</span>
        </div>
        <div className={styles.titlebarRight}>
          {/* macOS reaches Settings via the native menu bar (⌘,); the gear
              lives in the custom title bar on the other platforms. */}
          {!isMac && (
            <button
              type="button"
              className={styles.settingsBtn}
              aria-label="Settings"
              title={withHint("Settings", keymap, "openSettings")}
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon size={16} />
            </button>
          )}
          {isWindows && <WindowControls />}
        </div>
      </header>

      <div className={styles.body}>
        <Sidebar />
        <div
          className={styles.sidebarResizer}
          onMouseDown={onSidebarResizerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
        <main className={styles.work}>
          <TabBar />
          <div className={styles.panes}>
            <Pane id="local" title="Local" Icon={LocalIcon} />
            <Pane id="remote" title="Remote" Icon={ServerIcon} />
            <PreviewPanel />
          </div>
          <TransferPanel />
        </main>
      </div>

      <Toasts />
      <DragGhost />
      <ConnectionForm />
      <PromptHost />
      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          useSettingsRequestStore.getState().clear();
        }}
      />
      <SyncDialog />
      <TabCloseModal />
      <CloseWarningModal
        open={closeWarnOpen}
        onClose={() => setCloseWarnOpen(false)}
      />
    </div>
  );
}
