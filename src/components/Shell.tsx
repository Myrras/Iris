/**
 * The islands below the title bar: the sidebar on the left and the work
 * column on the right (tab strip, the Local and Remote panes with the
 * preview island at their right, the transfer island underneath). Between
 * the islands sit `Splitter`s in the canvas gaps: sidebar width, the
 * Local/Remote split, the preview width and the transfer list height. The
 * sizes live in `layoutStore`; `useShellLayout` clamps them to the window and
 * writes them to CSS variables on this container.
 *
 * A closed preview and a collapsed transfer island take no resizable space:
 * their splitter is absent (preview) or only a gap (transfers).
 */

import {
  PANES_DEFAULT_RATIO,
  PREVIEW_DEFAULT_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  TRANSFERS_DEFAULT_HEIGHT,
} from "../lib/resize";
import { useShellLayout } from "../lib/useShellLayout";
import { useLayoutStore } from "../state/layoutStore";
import { Pane } from "./Pane";
import { PreviewPanel } from "./PreviewPanel";
import { Sidebar } from "./Sidebar";
import { Splitter } from "./Splitter";
import { TabBar } from "./TabBar";
import { TransferPanel } from "./TransferPanel";
import { LocalIcon, ServerIcon } from "./icons";
import styles from "./Shell.module.css";

export function Shell() {
  const { ref, layout, draft } = useShellLayout();
  const previewOpen = useLayoutStore((s) => s.previewOpen);
  const collapsed = useLayoutStore((s) => s.transfersCollapsed);
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const setPanesRatio = useLayoutStore((s) => s.setPanesRatio);
  const setPreviewWidth = useLayoutStore((s) => s.setPreviewWidth);
  const setTransfersHeight = useLayoutStore((s) => s.setTransfersHeight);

  const { limits, panesTotal } = layout;
  const toRatio = (localPx: number) => localPx / panesTotal;

  return (
    <div ref={ref} className={styles.body}>
      <Sidebar />
      <Splitter
        orientation="vertical"
        label="Resize sidebar"
        value={layout.sidebar}
        min={limits.sidebar.min}
        max={limits.sidebar.max}
        defaultValue={SIDEBAR_DEFAULT_WIDTH}
        onResize={(v) => draft({ sidebarWidth: v })}
        onCommit={setSidebarWidth}
      />
      <main className={styles.work}>
        <div className={styles.tabs}>
          <TabBar />
        </div>
        <div className={styles.panes}>
          <div className={styles.paneLocal}>
            <Pane id="local" title="Local" Icon={LocalIcon} />
          </div>
          <Splitter
            orientation="vertical"
            label="Resize Local and Remote panes"
            value={layout.local}
            min={limits.local.min}
            max={limits.local.max}
            defaultValue={Math.round(panesTotal * PANES_DEFAULT_RATIO)}
            onResize={(v) => draft({ panesRatio: toRatio(v) })}
            onCommit={(v) => setPanesRatio(toRatio(v))}
          />
          <div className={styles.paneRemote}>
            <Pane id="remote" title="Remote" Icon={ServerIcon} />
          </div>
          {previewOpen && (
            <Splitter
              orientation="vertical"
              invert
              label="Resize preview"
              value={layout.previewWidth}
              min={limits.preview.min}
              max={limits.preview.max}
              defaultValue={PREVIEW_DEFAULT_WIDTH}
              onResize={(v) => draft({ previewWidth: v })}
              onCommit={setPreviewWidth}
            />
          )}
          <PreviewPanel />
        </div>
        <Splitter
          orientation="horizontal"
          invert
          disabled={collapsed}
          label="Resize transfers"
          value={layout.transfers}
          min={limits.transfers.min}
          max={limits.transfers.max}
          defaultValue={TRANSFERS_DEFAULT_HEIGHT}
          onResize={(v) => draft({ transfersHeight: v })}
          onCommit={setTransfersHeight}
        />
        <TransferPanel />
      </main>
    </div>
  );
}
