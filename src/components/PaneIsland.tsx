/**
 * One file-pane island (Local or Remote): a titled, rounded, elevated card on
 * the canvas, styled like Podium's work island. Phase 0 fills it with a
 * placeholder; the file list arrives in Phase 1.
 */

import type { ComponentType, ReactNode } from "react";

import styles from "./PaneIsland.module.css";

export function PaneIsland({
  title,
  Icon,
  children,
}: {
  title: string;
  Icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <section className={styles.pane} aria-label={`${title} files`}>
      <header className={styles.header}>
        <Icon className={styles.icon} />
        <h2 className={styles.title}>{title}</h2>
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
