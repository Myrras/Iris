/**
 * The left sidebar island: the Connections section and, pinned below it, the
 * "New connection…" button.
 */

import { useConnectionFormStore } from "../state/connectionFormStore";
import { useLayoutStore } from "../state/layoutStore";
import { ConnectionSidebar } from "./ConnectionSidebar";
import { AddIcon } from "./icons";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const openNew = useConnectionFormStore((s) => s.openNew);

  return (
    <aside
      className={styles.sidebar}
      style={{ width: sidebarWidth, minWidth: sidebarWidth }}
      aria-label="Sidebar"
    >
      <div className={styles.groups}>
        <ConnectionSidebar />
      </div>

      <div className={styles.footer}>
        <button type="button" className={styles.footerBtn} onClick={openNew}>
          <AddIcon />
          <span>New connection…</span>
        </button>
      </div>
    </aside>
  );
}
