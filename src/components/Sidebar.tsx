/**
 * The left sidebar island: the Local section (Home and the Local favorites),
 * the Connections section and, pinned below them, the "New connection…"
 * button. Its width is the `--sidebar-w` variable the shell
 * sets from `layoutStore` (see `Shell`, `Splitter`).
 */

import { useConnectionFormStore } from "../state/connectionFormStore";
import { ConnectionSidebar } from "./ConnectionSidebar";
import { LocalSidebar } from "./LocalSidebar";
import { AddIcon } from "./icons";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const openNew = useConnectionFormStore((s) => s.openNew);

  return (
    <aside className={styles.sidebar} aria-label="Sidebar">
      <div className={styles.groups}>
        <LocalSidebar />
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
