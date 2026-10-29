/**
 * A list of favorite folders in the sidebar: the Local section's, or one
 * connection's (nested under its row). Rows look like `ConnectionRow`s with
 * a star for the dot; the label's tooltip is the full path.
 *
 * A click opens the folder (`onOpen`), ⌘-click (Ctrl-click off macOS) in a
 * new tab. Right-click: Open, Open in New Tab, Rename (an inline label edit;
 * blank = derived from the path again) and Remove. Pressing and dragging a
 * row reorders the list (`lib/rowReorder`, like the connections); the new
 * order goes to the core through `lib/favorites`, which re-reads it and puts
 * the backend's order back when it is refused.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Favorite } from "../ipc/types";
import {
  favoriteLabel,
  removeFavorite,
  renameFavorite,
  reorderFavorites,
  wantsNewTab,
  type FavoriteScope,
} from "../lib/favorites";
import { isMac } from "../lib/platform";
import { beginRowReorder, moveToInsertion } from "../lib/rowReorder";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FavoriteIcon } from "./icons";
import rowStyles from "./ConnectionRow.module.css";
import styles from "./FavoriteList.module.css";

export function FavoriteList({
  scope,
  favorites,
  label,
  nested = false,
  onOpen,
}: {
  scope: FavoriteScope;
  favorites: Favorite[];
  /** The list's accessible name ("Local favorites", "Favorites of prod"). */
  label: string;
  /** Indented under a connection row. */
  nested?: boolean;
  /** Show the folder, in a new tab when asked. */
  onOpen: (fav: Favorite, newTab: boolean) => void;
}) {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    fav: Favorite;
  } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{
    path: string;
    insert: number | null;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cancelDrag = useRef<(() => void) | null>(null);

  // A list that changes under a drag would make its insertion points lie.
  useEffect(() => cancelDrag.current?.(), [favorites]);
  useEffect(() => () => cancelDrag.current?.(), []);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  function startReorder(fav: Favorite, e: React.MouseEvent) {
    const from = favorites.findIndex((f) => f.path === fav.path);
    if (favorites.length < 2 || from < 0) return;
    cancelDrag.current = beginRowReorder({
      x: e.clientX,
      y: e.clientY,
      from,
      list: () => listRef.current,
      onStart: () => setDrag({ path: fav.path, insert: null }),
      onInsert: (insert) => setDrag((d) => d && { ...d, insert }),
      onDrop: (insert) =>
        void reorderFavorites(scope, moveToInsertion(favorites, from, insert)),
      onEnd: () => {
        cancelDrag.current = null;
        setDrag(null);
      },
    });
  }

  function menuItems(fav: Favorite): ContextMenuItem[] {
    return [
      { label: "Open", onSelect: () => onOpen(fav, false) },
      { label: "Open in New Tab", onSelect: () => onOpen(fav, true) },
      { label: "Rename", onSelect: () => setRenaming(fav.path) },
      {
        label: "Remove from Favorites",
        onSelect: () => void removeFavorite(scope, fav.path),
      },
    ];
  }

  return (
    <>
      <div
        role="list"
        aria-label={label}
        className={styles.list}
        data-nested={nested ? "true" : undefined}
        ref={listRef}
      >
        {favorites.map((fav, index) => {
          const name = favoriteLabel(fav, scope);
          // The line sits before the row the dragged one lands in front of,
          // or after the last row.
          const insert =
            drag?.insert === index
              ? "before"
              : drag?.insert === favorites.length &&
                  index === favorites.length - 1
                ? "after"
                : undefined;
          return (
            <div
              key={fav.path}
              role="listitem"
              className={rowStyles.item}
              data-insert={insert}
            >
              <div
                className={`${rowStyles.row} ${styles.row}`}
                data-reordering={drag?.path === fav.path ? "true" : undefined}
                role="button"
                tabIndex={0}
                title={fav.path}
                onClick={(e) => {
                  if (renaming !== fav.path) onOpen(fav, wantsNewTab(e));
                }}
                onMouseDown={(e) => {
                  // Not a context-menu click (Ctrl on a Mac), not the field.
                  if (e.button !== 0 || (isMac && e.ctrlKey)) return;
                  if (renaming === fav.path) return;
                  startReorder(fav, e);
                }}
                onKeyDown={(e) => {
                  if (renaming === fav.path) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(fav, wantsNewTab(e));
                  } else if (e.key === "F2") {
                    e.preventDefault();
                    setRenaming(fav.path);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, fav });
                  setMenuOpen(true);
                }}
              >
                <FavoriteIcon size={12} className={styles.icon} />
                {renaming === fav.path ? (
                  <LabelField
                    initial={name}
                    path={fav.path}
                    onDone={(draft) => {
                      setRenaming(null);
                      if (draft === null) return;
                      // Confirming the derived name keeps it derived.
                      if (!fav.label && draft.trim() === name) return;
                      void renameFavorite(scope, fav.path, draft);
                    }}
                  />
                ) : (
                  <span className={rowStyles.name}>{name}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <ContextMenu
        open={menuOpen}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu ? menuItems(menu.fav) : []}
        onClose={closeMenu}
      />
    </>
  );
}

/**
 * The inline label edit: Enter or leaving the field saves, Escape cancels
 * (`onDone(null)`). Starts with the shown name selected.
 */
function LabelField({
  initial,
  path,
  onDone,
}: {
  initial: string;
  path: string;
  onDone: (draft: string | null) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  function finish(value: string | null) {
    if (done.current) return;
    done.current = true;
    onDone(value);
  }

  return (
    <input
      ref={ref}
      className={styles.labelInput}
      value={draft}
      aria-label={`Rename favorite ${path}`}
      placeholder={path}
      maxLength={255}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      // The row's click (open) and press (reorder) must not see these.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(draft)}
    />
  );
}
