/**
 * Virtualised file listing: TanStack Table for the column model (headers,
 * sizes, sort state, cell renderers) and TanStack Virtual for windowing the
 * rows — the pairing Selene's ResultsGrid uses, so a 10,000-entry folder only
 * mounts the rows on screen.
 *
 * Purely presentational: entries arrive filtered and sorted, selection and
 * cursor come from the pane store, and every interaction is a callback.
 */

import { useEffect, useMemo, useRef } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Entry } from "../ipc/types";
import { formatModified, formatModifiedFull } from "../lib/dateFormat";
import { isDirLike, type SortKey, type SortSpec } from "../lib/entries";
import { formatPermissions, formatSize } from "../lib/fileFormat";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FileIcon,
  FolderIcon,
  OtherFileIcon,
  SymlinkIcon,
} from "./icons";
import styles from "./FileTable.module.css";

const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 24;

/** Tooltip of a symlink's name: where it points, and whether it is broken. */
function linkTitle(entry: Entry): string | undefined {
  if (entry.kind.type !== "symlink") return undefined;
  const target = entry.kind.target ?? "unreadable target";
  return entry.kind.targetKind === null
    ? `Broken link → ${target}`
    : `Link → ${target}`;
}

function NameCell({ entry }: { entry: Entry }) {
  const kind = entry.kind;
  const Glyph = isDirLike(entry)
    ? FolderIcon
    : kind.type === "other"
      ? OtherFileIcon
      : FileIcon;
  const link = kind.type === "symlink";
  return (
    <span className={styles.name} title={linkTitle(entry) ?? entry.name}>
      <Glyph
        className={styles.kindIcon}
        data-dir={isDirLike(entry) ? "true" : undefined}
      />
      <span className={styles.nameText}>{entry.name}</span>
      {link && (
        <SymlinkIcon
          className={styles.linkIcon}
          data-broken={kind.targetKind === null ? "true" : undefined}
          aria-label="Symbolic link"
          aria-hidden={false}
          role="img"
        />
      )}
    </span>
  );
}

const col = createColumnHelper<Entry>();

/** Column ids are the pane's sort keys. */
const COLUMNS: ColumnDef<Entry, unknown>[] = [
  col.display({
    id: "name",
    header: "Name",
    size: 120, // minimum; the name column takes the remaining width
    cell: ({ row }) => <NameCell entry={row.original} />,
  }),
  col.display({
    id: "size",
    header: "Size",
    size: 64,
    meta: { align: "right" },
    cell: ({ row }) =>
      isDirLike(row.original) ? "" : formatSize(row.original.size),
  }),
  col.display({
    id: "mtime",
    header: "Modified",
    size: 108,
    cell: ({ row }) => (
      <span title={formatModifiedFull(row.original.mtime)}>
        {formatModified(row.original.mtime)}
      </span>
    ),
  }),
  col.display({
    id: "mode",
    header: "Permissions",
    size: 84,
    meta: { mono: true },
    cell: ({ row }) => formatPermissions(row.original.mode),
  }),
];

interface ColumnMeta {
  align?: "right";
  mono?: boolean;
}

export interface RowModifiers {
  meta: boolean;
  shift: boolean;
}

interface FileTableProps {
  /** Already filtered and sorted. */
  entries: Entry[];
  sort: SortSpec;
  onSort: (key: SortKey) => void;
  selection: ReadonlySet<string>;
  cursor: string | null;
  onRowClick: (entry: Entry, mods: RowModifiers) => void;
  /** Double-click / Enter on an entry. */
  onOpen: (entry: Entry) => void;
  /** Arrow keys: move the cursor `delta` rows; Shift extends the selection. */
  onMove: (delta: number, extend: boolean) => void;
  onSelectAll: () => void;
  /** Accessible name, e.g. "Remote files list". */
  label: string;
  /** Shown instead of rows when `entries` is empty. */
  emptyText: string;
}

export function FileTable({
  entries,
  sort,
  onSort,
  selection,
  cursor,
  onRowClick,
  onOpen,
  onMove,
  onSelectAll,
  label,
  emptyText,
}: FileTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const sorting = useMemo(
    () => [{ id: sort.key, desc: sort.dir === "desc" }],
    [sort],
  );
  const table = useReactTable({
    data: entries,
    columns: COLUMNS,
    state: { sorting },
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (entry) => entry.path,
  });
  const rows = table.getRowModel().rows;
  const leafColumns = table.getVisibleLeafColumns();

  // The columns fit the pane: Name takes the remaining width (down to its
  // minimum), the others keep their compact size. Only a pane narrower than
  // the sum of the minimums scrolls sideways (`--min-w` on the canvas).
  const gridTemplate = leafColumns
    .map((c) =>
      c.id === "name" ? `minmax(${c.getSize()}px, 1fr)` : `${c.getSize()}px`,
    )
    .join(" ");
  const minWidth = leafColumns.reduce((sum, c) => sum + c.getSize(), 0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // The header sits above the first row inside the scroll element.
    scrollPaddingStart: HEADER_HEIGHT,
  });

  // Keep the keyboard cursor in view.
  const cursorIndex = useMemo(
    () => (cursor ? entries.findIndex((e) => e.path === cursor) : -1),
    [entries, cursor],
  );
  useEffect(() => {
    if (cursorIndex >= 0) virtualizer.scrollToIndex(cursorIndex);
  }, [cursorIndex, virtualizer]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      onMove(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
    } else if (e.key === "Enter" && cursorIndex >= 0) {
      e.preventDefault();
      onOpen(entries[cursorIndex]);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onSelectAll();
    }
  }

  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length + 1}
      aria-multiselectable="true"
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={
        {
          "--cols": gridTemplate,
          "--min-w": `${minWidth}px`,
        } as React.CSSProperties
      }
    >
      <div
        className={styles.canvas}
        style={{ height: HEADER_HEIGHT + virtualizer.getTotalSize() }}
      >
        <div
          className={styles.headerRow}
          role="row"
          aria-rowindex={1}
          style={{ height: HEADER_HEIGHT }}
        >
          {headers.map((header) => {
            const key = header.column.id as SortKey;
            const active = sort.key === key;
            const meta = header.column.columnDef.meta as ColumnMeta | undefined;
            return (
              <div
                key={header.id}
                role="columnheader"
                aria-sort={
                  active
                    ? sort.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className={styles.headerCell}
              >
                <button
                  type="button"
                  className={styles.sortBtn}
                  data-align={meta?.align}
                  onClick={() => onSort(key)}
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
                  {active &&
                    (sort.dir === "asc" ? (
                      <ChevronUpIcon size={12} />
                    ) : (
                      <ChevronDownIcon size={12} />
                    ))}
                </button>
              </div>
            );
          })}
        </div>

        {rows.length === 0 && <div className={styles.empty}>{emptyText}</div>}

        {virtualizer.getVirtualItems().map((vr) => {
          const row = rows[vr.index];
          const entry = row.original;
          const selected = selection.has(entry.path);
          return (
            <div
              key={row.id}
              role="row"
              aria-rowindex={vr.index + 2}
              aria-selected={selected}
              className={styles.row}
              data-selected={selected ? "true" : undefined}
              data-cursor={entry.path === cursor ? "true" : undefined}
              data-hidden={entry.hidden ? "true" : undefined}
              style={{
                transform: `translateY(${HEADER_HEIGHT + vr.start}px)`,
                height: vr.size,
              }}
              onMouseDown={(e) => {
                // Keep Shift-click from selecting text across rows.
                if (e.shiftKey) e.preventDefault();
              }}
              onClick={(e) =>
                onRowClick(entry, {
                  meta: e.metaKey || e.ctrlKey,
                  shift: e.shiftKey,
                })
              }
              onDoubleClick={() => onOpen(entry)}
            >
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta as
                  ColumnMeta | undefined;
                return (
                  <div
                    key={cell.id}
                    role="gridcell"
                    className={styles.cell}
                    data-align={meta?.align}
                    data-mono={meta?.mono ? "true" : undefined}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
