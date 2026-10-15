/**
 * Confirms a delete before it happens (Selene's GuardModal pattern): names
 * how many entries and the first few, and says where they go — the Trash
 * for local files, gone for good on a server. Enter confirms, Escape
 * cancels.
 */

import { useEffect, useRef } from "react";

import { itemCount, TRASH_NAME } from "../state/paneStore";
import { Modal } from "./Modal";
import styles from "./DeleteConfirmModal.module.css";

/** How many names the dialog lists before "and N more". */
const SHOWN_NAMES = 5;

export interface DeleteRequest {
  names: string[];
  /** Remote deletes are permanent; local ones go to the Trash. */
  remote: boolean;
}

export function DeleteConfirmModal({
  request,
  onConfirm,
  onCancel,
}: {
  request: DeleteRequest | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Keep the last request so the dialog can animate out after the parent
  // clears it.
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;

  useEffect(() => {
    if (!request) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      const t = e.target as HTMLElement | null;
      // A focused button (Cancel!) answers Enter itself.
      if (t && ["INPUT", "TEXTAREA", "BUTTON"].includes(t.tagName)) return;
      e.preventDefault();
      onConfirm();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [request, onConfirm]);

  if (!shown) return null;
  const { names, remote } = shown;
  const single = names.length === 1;
  const subject = single ? `“${names[0]}”` : itemCount(names.length);
  const rest = names.length - SHOWN_NAMES;

  return (
    <Modal
      open={request !== null}
      title={
        remote ? `Delete ${subject}?` : `Move ${subject} to the ${TRASH_NAME}?`
      }
      tone={remote ? "danger" : "warning"}
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            {remote ? "Delete permanently" : `Move to ${TRASH_NAME}`}
          </button>
        </>
      }
    >
      <p className={styles.lead}>
        {remote ? (
          <>
            {single ? "This item" : "These items"} will be deleted from the
            server <strong>permanently</strong>, folders with everything in
            them. This cannot be undone.
          </>
        ) : (
          <>
            {single ? "This item" : "These items"} will be moved to the{" "}
            <strong>{TRASH_NAME}</strong>, where you can restore{" "}
            {single ? "it" : "them"}.
          </>
        )}
      </p>
      {!single && (
        <ul className={styles.names}>
          {names.slice(0, SHOWN_NAMES).map((name) => (
            <li key={name}>{name}</li>
          ))}
          {rest > 0 && <li className={styles.more}>and {rest} more</li>}
        </ul>
      )}
    </Modal>
  );
}
