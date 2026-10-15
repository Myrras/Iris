/**
 * One file-pane island (Local or Remote): a header, a toolbar (Back, Up,
 * Refresh, breadcrumb, filter, hidden-files toggle) and the virtualised file
 * table. All state lives in `paneStore`; this component derives the visible
 * rows and turns clicks and keys into store actions.
 *
 * The remote pane without a session shows the welcome screen; a session that
 * dropped shows why, with Reconnect.
 */

import { useCallback, useMemo, type ComponentType } from "react";

import type { Entry } from "../ipc/types";
import { connectProfile } from "../lib/connect";
import { isDirLike, visibleEntries } from "../lib/entries";
import { parentPath } from "../lib/path";
import { clickSelection, moveCursor } from "../lib/selection";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { usePaneStore, type PaneId } from "../state/paneStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { useSettingsStore } from "../state/settingsStore";
import { Breadcrumb } from "./Breadcrumb";
import { FileTable, type RowModifiers } from "./FileTable";
import { WelcomeScreen } from "./WelcomeScreen";
import {
  BackIcon,
  DisconnectIcon,
  FilterIcon,
  HideHiddenIcon,
  ParentDirIcon,
  RefreshIcon,
  ShowHiddenIcon,
} from "./icons";
import styles from "./Pane.module.css";

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
  const profile = useProfilesStore((s) =>
    session ? s.profiles.find((p) => p.id === session.profileId) : undefined,
  );
  const openNew = useConnectionFormStore((s) => s.openNew);

  let body;
  if (!target) {
    body = <WelcomeScreen onConnect={openNew} />;
  } else if (session?.state === "disconnected") {
    body = (
      <div className={styles.notice}>
        <DisconnectIcon size={28} className={styles.noticeIcon} />
        <p className={styles.noticeTitle}>
          Disconnected{profile ? ` from ${profile.name}` : ""}
        </p>
        {session.reason && (
          <p className={styles.noticeText}>{session.reason}</p>
        )}
        <div className={styles.noticeActions}>
          <button
            type="button"
            onClick={() => usePaneStore.getState().close(id)}
          >
            Close
          </button>
          {profile && (
            <button
              type="button"
              className="primary"
              onClick={() => void connectProfile(profile)}
            >
              Reconnect
            </button>
          )}
        </div>
      </div>
    );
  } else {
    body = <PaneBrowser id={id} label={title} />;
  }

  return (
    <section className={styles.pane} aria-label={`${title} files`}>
      <header className={styles.header}>
        <Icon className={styles.icon} />
        <h2 className={styles.title}>{title}</h2>
        {profile && <span className={styles.subtitle}>{profile.name}</span>}
      </header>
      <div className={styles.body}>{body}</div>
    </section>
  );
}

/** Toolbar + table for a pane that has a filesystem. */
function PaneBrowser({ id, label }: { id: PaneId; label: string }) {
  const pane = usePaneStore((s) => s.panes[id]);
  const settingsShowHidden = useSettingsStore((s) => s.browser.showHidden);
  const showHidden = pane.showHidden ?? settingsShowHidden;
  const store = usePaneStore.getState;

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

  const canGoUp = pane.path !== null && parentPath(pane.path) !== null;
  const emptyText = pane.loading
    ? "Loading…"
    : pane.error
      ? pane.error
      : pane.filter.trim()
        ? "No matches."
        : "This folder is empty.";

  return (
    <>
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
          aria-label="Show hidden files"
          aria-pressed={showHidden}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
          onClick={() => store().setShowHidden(id, !showHidden)}
        >
          {showHidden ? <ShowHiddenIcon /> : <HideHiddenIcon />}
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
        onMove={onMove}
        onSelectAll={onSelectAll}
        label={`${label} files list`}
        emptyText={emptyText}
      />
    </>
  );
}
