/**
 * Warns before Iris quits while work is still in flight.
 *
 * Raised by the backend's close/exit guard (via the `window:close-requested`
 * event, see `Core::has_active_work` — unfinished transfers); "Close anyway"
 * confirms via `windowConfirmClose` (which arms the backend force-close flag
 * and exits). Lists what would be interrupted, as Podium lists its
 * processes: the running, queued, waiting and paused transfers (re-pulled
 * when the dialog opens).
 */

import { useEffect, useMemo, useState } from "react";

import { toIpcError, windowConfirmClose } from "../ipc/commands";
import { transferCount, transferTotals } from "../lib/transferFormat";
import { toastError } from "../state/toastStore";
import { useTransferStore } from "../state/transferStore";
import { Modal } from "./Modal";
import { StatusDot } from "./StatusDot";
import styles from "./CloseWarningModal.module.css";

export function CloseWarningModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const jobs = useTransferStore((s) => s.jobs);
  const totals = useMemo(() => transferTotals(Object.values(jobs), {}), [jobs]);

  useEffect(() => {
    if (open) void useTransferStore.getState().resync();
  }, [open]);

  const confirm = async () => {
    setBusy(true);
    try {
      await windowConfirmClose();
      // On success the app exits, so nothing more to do; if it somehow returns
      // (see catch), the user can retry.
    } catch (e) {
      setBusy(false);
      toastError("Could not close Iris", toIpcError(e).message);
    }
  };

  const unfinished =
    totals.active + totals.queued + totals.needsDecision + totals.paused;
  const lines = [
    { n: totals.active, text: "copying", tone: "busy" as const },
    { n: totals.queued, text: "queued", tone: "idle" as const },
    {
      n: totals.needsDecision,
      text: "waiting for your answer",
      tone: "warning" as const,
    },
    { n: totals.paused, text: "paused", tone: "warning" as const },
  ].filter((l) => l.n > 0);

  return (
    <Modal
      open={open}
      title="Work still in progress"
      tone="warning"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "Closing…" : "Close anyway"}
          </button>
        </>
      }
    >
      <p className={styles.intro}>
        {unfinished > 0
          ? `${transferCount(unfinished)} will be interrupted if you close Iris now. Partly copied files stay where they are.`
          : "Iris is still busy. Closing now will interrupt any transfers in progress."}
      </p>
      {lines.length > 0 && (
        <ul className={styles.list} aria-label="Unfinished transfers">
          {lines.map((l) => (
            <li key={l.text} className={styles.item}>
              <StatusDot tone={l.tone} label={l.text} />
              <span>
                {l.n} {l.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
