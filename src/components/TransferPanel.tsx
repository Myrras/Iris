/**
 * The bottom transfer island. Phase 0 is a collapsible placeholder; the
 * transfer queue (progress, retry, cancel) fills it in Phase 5. The collapse
 * state persists via `layoutStore`.
 */

import { useLayoutStore } from "../state/layoutStore";
import { CaretIcon, TransfersIcon } from "./icons";
import styles from "./TransferPanel.module.css";

export function TransferPanel() {
  const collapsed = useLayoutStore((s) => s.transfersCollapsed);
  const setCollapsed = useLayoutStore((s) => s.setTransfersCollapsed);

  return (
    <section className={styles.panel} aria-label="Transfers">
      <button
        type="button"
        className={styles.header}
        aria-expanded={!collapsed}
        aria-controls="transfer-panel-body"
        title={`${collapsed ? "Expand" : "Collapse"} Transfers`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span
          className={styles.caretWrap}
          data-open={!collapsed ? "true" : undefined}
        >
          <CaretIcon size={12} />
        </span>
        <TransfersIcon className={styles.icon} />
        <span className={styles.title}>Transfers</span>
      </button>
      <div
        id="transfer-panel-body"
        className={`${styles.body}${collapsed ? ` ${styles.bodyCollapsed}` : ""}`}
        aria-hidden={collapsed}
      >
        <div className={styles.bodyInner}>
          <p className={styles.placeholder}>No transfers yet.</p>
        </div>
      </div>
    </section>
  );
}
