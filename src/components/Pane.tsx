/**
 * One file-pane island (Local or Remote): a header, a toolbar (Back, Up,
 * Refresh, breadcrumb, filter, New Folder, hidden-files and preview toggles)
 * and the virtualised file table. All state lives in `paneStore`; this
 * component derives the visible rows and turns clicks, keys and the context
 * menu into store actions.
 *
 * Shortcuts (Finder's on macOS, with Ctrl for Cmd elsewhere): Cmd+Shift+N new
 * folder; F2, or Enter on macOS, rename; Delete / Cmd+Backspace delete (always
 * confirmed); Cmd+I Get Info; Space preview; Cmd+Down / Cmd+O open; Cmd+Up
 * enclosing folder. Transfers: Cmd+Shift+U uploads the Local selection,
 * Cmd+Shift+D downloads the Remote selection, and F5 (Total Commander's
 * "copy to the other pane") does either, into the other pane's folder.
 *
 * Rows dragged onto the other pane (or a folder row in it) transfer too
 * (`lib/paneDrag`); the pane under the drag, and the folder row, light up.
 * Files dragged in from Finder / Explorer (`lib/useNativeDrop`) show a drop
 * overlay on the Remote pane.
 *
 * The remote pane without a session shows the welcome screen, or — in a
 * tab about a connection (restored at start, or disconnected by the user) —
 * "not connected" with Reconnect, which opens a new session for the tab.
 * While the core reconnects a dropped session the listing stays visible
 * under a banner (attempt n of max, a countdown, Retry now, Disconnect); a
 * session the core gave up on shows why, with Retry (same session id) and
 * Disconnect.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";

import type { ConnectionProfile, Entry, SessionId } from "../ipc/types";
import { connectInTab, retrySession } from "../lib/connect";
import { isDirLike, visibleEntries } from "../lib/entries";
import { startPaneDrag } from "../lib/paneDrag";
import { baseName, parentPath } from "../lib/path";
import { isMac } from "../lib/platform";
import { clickSelection, moveCursor } from "../lib/selection";
import { requestDisconnectSession } from "../lib/tabs";
import { otherPane, startTransfer } from "../lib/transfer";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { useDragStore } from "../state/dragStore";
import { useLayoutStore } from "../state/layoutStore";
import { actionTargets, usePaneStore, type PaneId } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { useSettingsStore } from "../state/settingsStore";
import { useTabsStore, type Tab } from "../state/tabsStore";
import { Breadcrumb } from "./Breadcrumb";
import { ChmodDialog, type ChmodRequest } from "./ChmodDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DeleteConfirmModal, type DeleteRequest } from "./DeleteConfirmModal";
import { FileTable, type RowModifiers } from "./FileTable";
import { WelcomeScreen } from "./WelcomeScreen";
import {
  BackIcon,
  DisconnectIcon,
  DownloadIcon,
  FilterIcon,
  HideHiddenIcon,
  NewFolderIcon,
  ParentDirIcon,
  PreviewIcon,
  RefreshIcon,
  ShowHiddenIcon,
  UploadIcon,
} from "./icons";
import styles from "./Pane.module.css";

/** Typing in a field (filter, rename, dialogs) never triggers shortcuts. */
function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

export function Pane({
  id,
  title,
  Icon,
}: {
  id: PaneId;
  title: string;
  Icon: ComponentType<{ className?: string }>;
}) {
  const target = usePaneStore((s) => s.panes[id].target);
  const sessionId = target?.kind === "remote" ? target.sessionId : null;
  const session = useSessionStore((s) =>
    sessionId ? s.sessions[sessionId] : undefined,
  );
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const profileId =
    session?.profileId ?? (id === "remote" ? tab?.profileId : undefined);
  const profile = useProfilesStore((s) =>
    profileId ? s.profiles.find((p) => p.id === profileId) : undefined,
  );
  const openNew = useConnectionFormStore((s) => s.openNew);
  const state = session?.state;

  let body;
  if (!target) {
    body =
      id === "remote" && tab && profile ? (
        <NotConnected tab={tab} profile={profile} />
      ) : (
        <WelcomeScreen onConnect={openNew} />
      );
  } else if (sessionId && state?.status === "disconnected") {
    body = (
      <ConnectionLost
        sessionId={sessionId}
        name={profile?.name}
        reason={state.reason}
      />
    );
  } else {
    body = (
      <>
        {sessionId && state?.status === "reconnecting" && (
          <ReconnectBanner
            key={`${state.attempt}:${state.nextRetryInSecs}`}
            sessionId={sessionId}
            attempt={state.attempt}
            maxAttempts={state.maxAttempts}
            nextRetryInSecs={state.nextRetryInSecs}
          />
        )}
        <PaneBrowser id={id} label={title} />
      </>
    );
  }

  const setActive = () => usePaneStore.getState().setActive(id);

  // A drag (from the other pane, or from the OS) would drop here.
  const dropHere = useDragStore((s) => s.over?.pane === id);
  const nativeOver = useDragStore((s) =>
    s.nativeDrag && s.over?.pane === id ? s.over : null,
  );
  const path = usePaneStore((s) => s.panes[id].path);
  const connected =
    !!target && (!session || session.state.status === "connected");

  return (
    <section
      className={styles.pane}
      aria-label={`${title} files`}
      data-drop-pane={id}
      data-drop-target={dropHere ? "true" : undefined}
      onMouseDownCapture={setActive}
      onFocusCapture={setActive}
    >
      <header className={styles.header}>
        <Icon className={styles.icon} />
        <h2 className={styles.title}>{title}</h2>
        {profile && <span className={styles.subtitle}>{profile.name}</span>}
      </header>
      <div className={styles.body}>{body}</div>
      {nativeOver && (
        <div className={styles.dropOverlay} role="status">
          <UploadIcon size={24} />
          <span>
            {connected && path
              ? `Drop to upload to ${baseName(nativeOver.dir ?? path)}`
              : "Connect to a server to upload"}
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * The remote pane of a tab about a connection without a session: restored
 * at start (Iris never connects on its own) or disconnected by the user.
 */
function NotConnected({
  tab,
  profile,
}: {
  tab: Tab;
  profile: ConnectionProfile;
}) {
  return (
    <div className={styles.notice}>
      <DisconnectIcon size={28} className={styles.noticeIcon} />
      <p className={styles.noticeTitle}>{profile.name} — not connected</p>
      {tab.pendingRemotePath && (
        <p className={styles.noticeText}>
          Reconnecting opens {tab.pendingRemotePath} again.
        </p>
      )}
      <div className={styles.noticeActions}>
        <button
          type="button"
          className="primary"
          disabled={tab.connecting}
          onClick={() => void connectInTab(tab.id, profile)}
        >
          {tab.connecting ? "Connecting…" : "Reconnect"}
        </button>
      </div>
    </div>
  );
}

/** A dropped session the core stopped retrying (or could not retry). */
function ConnectionLost({
  sessionId,
  name,
  reason,
}: {
  sessionId: SessionId;
  name: string | undefined;
  reason: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await retrySession(sessionId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.notice}>
      <DisconnectIcon size={28} className={styles.noticeIcon} />
      <p className={styles.noticeTitle}>
        Disconnected{name ? ` from ${name}` : ""}
      </p>
      {reason && <p className={styles.noticeText}>{reason}</p>}
      <div className={styles.noticeActions}>
        <button
          type="button"
          onClick={() => requestDisconnectSession(sessionId)}
        >
          Disconnect
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void retry()}
        >
          {busy ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

/**
 * Seconds left of `from` (as of the event), counted down locally once a
 * second. The banner is keyed by attempt and wait, so every new event
 * starts a fresh countdown.
 */
function useCountdown(from: number): number {
  const [left, setLeft] = useState(from);
  useEffect(() => {
    if (from <= 0) return;
    const timer = setInterval(() => {
      setLeft((n) => Math.max(0, n - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [from]);
  return left;
}

/** Over the listing while the core reconnects a dropped session. */
function ReconnectBanner({
  sessionId,
  attempt,
  maxAttempts,
  nextRetryInSecs,
}: {
  sessionId: SessionId;
  attempt: number;
  maxAttempts: number;
  nextRetryInSecs: number;
}) {
  const left = useCountdown(nextRetryInSecs);
  return (
    <div className={styles.banner} role="status">
      <span className="spinner" aria-hidden />
      <span className={styles.bannerText}>
        <strong>Connection lost</strong> — reconnecting (attempt {attempt} of{" "}
        {maxAttempts}).{" "}
        <span className={styles.bannerMuted}>
          {left > 0 ? `Next try in ${left}s` : "Trying…"}
        </span>
      </span>
      <span className={styles.bannerActions}>
        <button
          type="button"
          onClick={() => requestDisconnectSession(sessionId)}
        >
          Disconnect
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void retrySession(sessionId)}
        >
          Retry now
        </button>
      </span>
    </div>
  );
}

/** Toolbar + table for a pane that has a filesystem. */
function PaneBrowser({ id, label }: { id: PaneId; label: string }) {
  const pane = usePaneStore((s) => s.panes[id]);
  const settingsShowHidden = useSettingsStore((s) => s.browser.showHidden);
  const showHidden = pane.showHidden ?? settingsShowHidden;
  const previewOpen = useLayoutStore((s) => s.previewOpen);
  const store = usePaneStore.getState;
  const remote = pane.target?.kind === "remote";

  // Copying to the other pane needs a live session and both folders.
  const otherPath = usePaneStore((s) => s.panes[otherPane(id)].path);
  const remoteTarget = usePaneStore((s) => s.panes.remote.target);
  const remoteStatus = useSessionStore((s) =>
    remoteTarget?.kind === "remote"
      ? s.sessions[remoteTarget.sessionId]?.state.status
      : undefined,
  );
  // Only a connected session can take a transfer (none heard yet = the
  // connect just resolved, so it is up).
  const canCopy =
    remoteTarget?.kind === "remote" &&
    (remoteStatus === undefined || remoteStatus === "connected") &&
    pane.path !== null &&
    otherPath !== null;
  const hasTargets = pane.selection.length > 0 || pane.cursor !== null;
  const dropDir = useDragStore((s) =>
    s.over?.pane === id ? s.over.dir : null,
  );

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  // The menu keeps its last position and items while it animates out.
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const [deleting, setDeleting] = useState<
    (DeleteRequest & { paths: string[] }) | null
  >(null);
  const [info, setInfo] = useState<ChmodRequest | null>(null);

  const entries = useMemo(
    () =>
      visibleEntries(pane.entries, {
        showHidden,
        filter: pane.filter,
        sort: pane.sort,
      }),
    [pane.entries, showHidden, pane.filter, pane.sort],
  );
  const paths = useMemo(() => entries.map((e) => e.path), [entries]);
  const selection = useMemo(() => new Set(pane.selection), [pane.selection]);

  const onRowClick = useCallback(
    (entry: Entry, mods: RowModifiers) => {
      const { selection, anchor } = store().panes[id];
      store().setSelection(
        id,
        clickSelection({ selection, anchor }, paths, entry.path, mods),
      );
    },
    [id, paths, store],
  );
  const onMove = useCallback(
    (delta: number, extend: boolean) => {
      const { selection, anchor, cursor } = store().panes[id];
      store().setSelection(
        id,
        moveCursor({ selection, anchor, cursor }, paths, delta, extend),
      );
    },
    [id, paths, store],
  );
  const onSelectAll = useCallback(() => {
    const { cursor } = store().panes[id];
    store().setSelection(id, {
      selection: paths,
      anchor: paths[0] ?? null,
      cursor,
    });
  }, [id, paths, store]);
  const onOpen = useCallback(
    (entry: Entry) => {
      if (isDirLike(entry)) void store().navigate(id, entry.path);
    },
    [id, store],
  );

  // -- Actions (shared by shortcuts, toolbar and context menu) ---------------

  const hasFolder = pane.path !== null;
  const targets = () => actionTargets(store().panes[id]);
  const newFolder = () => {
    if (hasFolder) void store().newFolder(id);
  };
  const rename = (entry?: Entry) => {
    const list = entry ? [entry] : targets();
    if (list.length === 1) store().startRename(id, list[0].path);
  };
  const askDelete = () => {
    const list = targets();
    if (list.length === 0) return;
    setDeleting({
      names: list.map((e) => e.name),
      paths: list.map((e) => e.path),
      remote,
    });
  };
  const getInfo = () => {
    const list = targets();
    if (list.length > 0) setInfo({ entries: list });
  };
  const togglePreview = () => useLayoutStore.getState().togglePreview();
  const openCursor = () => {
    const [entry] = targets();
    if (entry) onOpen(entry);
  };
  const copyToOther = () => {
    const list = targets();
    if (canCopy && list.length > 0) {
      void startTransfer(
        id,
        list.map((e) => e.path),
      );
    }
  };
  const copyVerb = id === "local" ? "Upload" : "Download";
  const copyKey = id === "local" ? "u" : "d";
  const copyShortcut = isMac
    ? `⇧⌘${copyKey.toUpperCase()}`
    : `Ctrl+Shift+${copyKey.toUpperCase()}`;
  const onRowDragStart = (entry: Entry, e: React.MouseEvent) => {
    if (!canCopy) return;
    startPaneDrag(id, entry, e.clientX, e.clientY);
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.defaultPrevented || isEditable(e.target)) return;
    // Dialogs and menus are portals: their keys bubble through React to
    // here, but they are not the pane's.
    if (!e.currentTarget.contains(e.target as Node)) return;
    // Space on a focused toolbar button presses it.
    if (e.key === " " && (e.target as HTMLElement).tagName === "BUTTON") return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (mod && e.shiftKey && key === "n") newFolder();
    else if (e.key === "F2") rename();
    else if (e.key === "Delete" || (mod && e.key === "Backspace")) askDelete();
    else if (mod && key === "i") getInfo();
    else if (e.key === " " && !mod) togglePreview();
    else if (mod && (e.key === "ArrowDown" || key === "o")) openCursor();
    else if (mod && e.key === "ArrowUp") void store().up(id);
    else if ((mod && e.shiftKey && key === copyKey) || e.key === "F5")
      copyToOther();
    else handled = false;
    if (handled) e.preventDefault();
  }

  function contextMenu(entry: Entry | null, e: React.MouseEvent) {
    // Right-clicking outside the selection selects that entry (Finder).
    if (entry && !store().panes[id].selection.includes(entry.path)) {
      store().setSelection(id, {
        selection: [entry.path],
        anchor: entry.path,
        cursor: entry.path,
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, items: menuItems(entry) });
  }

  function menuItems(entry: Entry | null): ContextMenuItem[] {
    const refresh: ContextMenuItem = {
      label: "Refresh",
      onSelect: () => void store().refresh(id),
    };
    const create: ContextMenuItem = {
      label: "New Folder",
      disabled: !hasFolder,
      onSelect: newFolder,
    };
    if (!entry) return [create, refresh];
    const list = targets();
    const single = list.length === 1;
    const noModes = list.every((t) => t.mode === null);
    return [
      {
        label: "Open",
        disabled: !(single && isDirLike(entry)),
        onSelect: () => onOpen(entry),
      },
      {
        label: "Preview",
        disabled: !single,
        onSelect: () => useLayoutStore.getState().setPreviewOpen(true),
      },
      {
        label: id === "local" ? "Upload to Remote" : "Download to Local",
        disabled: !canCopy,
        onSelect: copyToOther,
      },
      create,
      { label: "Rename", disabled: !single, onSelect: () => rename(entry) },
      {
        label: noModes ? "Get Info…" : "Get Info / Permissions…",
        onSelect: getInfo,
      },
      refresh,
      {
        label: list.length > 1 ? `Delete ${list.length} Items…` : "Delete…",
        danger: true,
        onSelect: askDelete,
      },
    ];
  }

  const canGoUp = pane.path !== null && parentPath(pane.path) !== null;
  const emptyText = pane.loading
    ? "Loading…"
    : pane.error
      ? pane.error
      : pane.filter.trim()
        ? "No matches."
        : "This folder is empty.";

  return (
    <div className={styles.browser} onKeyDown={onKeyDown}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.tool}
          aria-label="Back"
          title="Back"
          disabled={pane.history.length === 0}
          onClick={() => void store().back(id)}
        >
          <BackIcon />
        </button>
        <button
          type="button"
          className={styles.tool}
          aria-label="Up"
          title="Enclosing folder"
          disabled={!canGoUp}
          onClick={() => void store().up(id)}
        >
          <ParentDirIcon />
        </button>
        <button
          type="button"
          className={styles.tool}
          aria-label="Refresh"
          title="Refresh"
          disabled={pane.path === null}
          data-loading={pane.loading ? "true" : undefined}
          onClick={() => void store().refresh(id)}
        >
          <RefreshIcon />
        </button>
        {pane.path ? (
          <Breadcrumb
            path={pane.path}
            onNavigate={(path) => void store().navigate(id, path)}
          />
        ) : (
          <span className={styles.crumbPlaceholder} />
        )}
        <label className={styles.filter}>
          <FilterIcon className={styles.filterIcon} />
          <span className="visually-hidden">Filter {label} files</span>
          <input
            type="search"
            className={styles.filterInput}
            placeholder="Filter"
            value={pane.filter}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => store().setFilter(id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && pane.filter) {
                e.stopPropagation();
                store().setFilter(id, "");
              }
            }}
          />
        </label>
        <button
          type="button"
          className={styles.tool}
          aria-label={copyVerb}
          title={`${copyVerb} to ${id === "local" ? "Remote" : "Local"} (${copyShortcut} or F5)`}
          disabled={!canCopy || !hasTargets}
          onClick={copyToOther}
        >
          {id === "local" ? <UploadIcon /> : <DownloadIcon />}
        </button>
        <button
          type="button"
          className={styles.tool}
          aria-label="New folder"
          title={`New folder (${isMac ? "⇧⌘N" : "Ctrl+Shift+N"})`}
          disabled={!hasFolder}
          onClick={newFolder}
        >
          <NewFolderIcon />
        </button>
        <button
          type="button"
          className={styles.tool}
          aria-label="Show hidden files"
          aria-pressed={showHidden}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
          onClick={() => store().setShowHidden(id, !showHidden)}
        >
          {showHidden ? <ShowHiddenIcon /> : <HideHiddenIcon />}
        </button>
        <button
          type="button"
          className={styles.tool}
          aria-label="Preview"
          aria-pressed={previewOpen}
          title="Preview (Space)"
          onClick={togglePreview}
        >
          <PreviewIcon />
        </button>
      </div>
      <FileTable
        entries={entries}
        sort={pane.sort}
        onSort={(key) => store().setSort(id, key)}
        selection={selection}
        cursor={pane.cursor}
        onRowClick={onRowClick}
        onOpen={onOpen}
        // Finder: Enter renames; elsewhere it opens (F2 renames).
        onEnter={isMac ? (entry) => rename(entry) : undefined}
        onMove={onMove}
        onSelectAll={onSelectAll}
        onContextMenu={contextMenu}
        editing={pane.editing}
        onRenameCommit={(entry, name) =>
          void store().commitRename(id, entry.path, name)
        }
        onRenameCancel={() => store().cancelRename(id)}
        label={`${label} files list`}
        emptyText={emptyText}
        onRowDragStart={onRowDragStart}
        dropDir={dropDir}
      />
      <ContextMenu
        open={menu !== null}
        x={lastMenu.current?.x ?? 0}
        y={lastMenu.current?.y ?? 0}
        items={lastMenu.current?.items ?? []}
        onClose={() => setMenu(null)}
      />
      <DeleteConfirmModal
        request={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          setDeleting(null);
          void store().remove(id, deleting.paths);
        }}
      />
      <ChmodDialog
        request={info}
        onClose={() => setInfo(null)}
        onApply={(mode, recursive) => {
          if (!info) return;
          setInfo(null);
          void store().chmod(
            id,
            info.entries.map((e) => e.path),
            mode,
            recursive,
          );
        }}
      />
    </div>
  );
}
