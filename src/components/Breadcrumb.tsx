/**
 * The pane's current folder as clickable segments (`/ › home › alice`). The
 * last segment is the current folder; earlier ones navigate there. A long path
 * keeps its tail in view. With `onEdit`, a click on the empty part of the bar
 * or a double-click (not on an ancestor button, which navigates) turns it
 * into the "go to path" field.
 */

import { useLayoutEffect, useRef } from "react";

import { pathSegments } from "../lib/path";
import { CaretIcon } from "./icons";
import styles from "./Breadcrumb.module.css";

export function Breadcrumb({
  path,
  onNavigate,
  onEdit,
  hint,
}: {
  path: string;
  onNavigate: (path: string) => void;
  onEdit?: () => void;
  /** Appended to the tooltip (how to type a path). */
  hint?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const segments = pathSegments(path);

  // Deep folders overflow: show the end (the current folder), not the root.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);

  return (
    <nav
      ref={ref}
      className={`${styles.crumbs} ${onEdit ? styles.editable : ""}`}
      aria-label="Path"
      title={onEdit && hint ? `${path} — ${hint}` : path}
      onClick={(e) => {
        // Only the empty part of the bar; segments keep their own click.
        if (e.target === ref.current || e.target === listRef.current)
          onEdit?.();
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("button")) onEdit?.();
      }}
    >
      <ol ref={listRef} className={styles.list}>
        {segments.map((seg, i) => {
          const last = i === segments.length - 1;
          return (
            <li key={seg.path} className={styles.item}>
              {i > 0 && <CaretIcon size={11} className={styles.sep} />}
              {last ? (
                <span className={styles.current} aria-current="location">
                  {seg.name}
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.segment}
                  onClick={() => onNavigate(seg.path)}
                >
                  {seg.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
