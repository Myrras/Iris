/**
 * Warns before Iris quits while work is still in flight.
 *
 * Raised by the backend's close/exit guard (via the `window:close-requested`
 * event, see `Core::has_active_work`); "Close anyway" confirms via
 * `windowConfirmClose` (which arms the backend force-close flag and exits).
 * Phase 0 has no work to interrupt, so the guard never fires yet; Phase 5
 * lists the running transfers here, as Podium lists its processes.
 */

import { useState } from "react";

import { toIpcError, windowConfirmClose } from "../ipc/commands";
import { toastError } from "../state/toastStore";
import { Modal } from "./Modal";
import styles from "./CloseWarningModal.module.css";

export function CloseWarningModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

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
        Iris is still busy. Closing now will interrupt any transfers in
        progress.
      </p>
    </Modal>
  );
}
