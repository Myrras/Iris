/**
 * The pane's current folder as clickable segments (`/ › home › alice`). The
 * last segment is the current folder; earlier ones navigate there. A long path
 * keeps its tail in view.
 */

import { useLayoutEffect, useRef } from "react";

import { pathSegments } from "../lib/path";
import { CaretIcon } from "./icons";
import styles from "./Breadcrumb.module.css";

export function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const segments = pathSegments(path);

  // Deep folders overflow: show the end (the current folder), not the root.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path]);

  return (
    <nav ref={ref} className={styles.crumbs} aria-label="Path" title={path}>
      <ol className={styles.list}>
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
