/**
 * The left sidebar island. Phase 0 holds a placeholder Connections section;
 * saved connections and the new-connection flow arrive in Phase 1.
 */

import { useState } from "react";

import { useLayoutStore } from "../state/layoutStore";
import { SectionTitle } from "./SectionTitle";
import { AddIcon, ServerIcon } from "./icons";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const [connectionsCollapsed, setConnectionsCollapsed] = useState(false);

  return (
    <aside
      className={styles.sidebar}
      style={{ width: sidebarWidth, minWidth: sidebarWidth }}
      aria-label="Sidebar"
    >
      <div className={styles.groups}>
        <section className={styles.subsection}>
          <div className={styles.sectionHeader}>
            <SectionTitle
              title="Connections"
              Icon={ServerIcon}
              count={0}
              collapsed={connectionsCollapsed}
              onToggle={() => setConnectionsCollapsed(!connectionsCollapsed)}
            />
          </div>
          <div
            className={`${styles.sectionBody}${connectionsCollapsed ? ` ${styles.sectionBodyCollapsed}` : ""}`}
          >
            <div className={styles.sectionBodyInner}>
              <div className={styles.placeholder}>No connections yet.</div>
            </div>
          </div>
        </section>
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.footerBtn}
          disabled
          title="Connections arrive in a later version"
        >
          <AddIcon />
          <span>New connection…</span>
        </button>
      </div>
    </aside>
  );
}
