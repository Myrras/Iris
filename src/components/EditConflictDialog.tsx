/**
 * A save of a file open in the local editor found the server copy changed
 * (or deleted) since it was opened: Overwrite server, Discard my changes or
 * Save as copy. Same look as the transfer `ConflictDialog` (warning modal,
 * bold file name lead, sides compared in a facts grid).
 *
 * Driven by the prompt queue (`edit:conflict` → `promptStore`). Closing it
 * (Escape, overlay, ✕) answers Save as copy — the answer that loses
 * neither version.
 */

import { useCallback, useState } from "react";

import { resolveEdit, toIpcError } from "../ipc/commands";
import type { EditResolution, RemoteStamp } from "../ipc/types";
import { formatModifiedFull } from "../lib/dateFormat";
import { formatSize } from "../lib/fileFormat";
import { baseName, parentPath } from "../lib/path";
import { usePromptStore, type Prompt } from "../state/promptStore";
import { toastError } from "../state/toastStore";
import { Modal } from "./Modal";
import styles from "./ConflictDialog.module.css";
import prompts from "./Prompts.module.css";

type EditConflictEntry = Extract<Prompt, { kind: "editConflict" }>;

function Side({ label, stamp }: { label: string; stamp: RemoteStamp | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={styles.size}>{stamp ? formatSize(stamp.size) : "—"}</dd>
      <dd className={styles.date}>
        {stamp ? formatModifiedFull(stamp.mtime) || "Unknown date" : "Deleted"}
      </dd>
    </>
  );
}

export function EditConflictDialog({
  prompt,
}: {
  prompt: EditConflictEntry | null;
}) {
  const resolve = usePromptStore((s) => s.resolve);
  const [busy, setBusy] = useState(false);
  // Keep the last prompt on screen while the dialog animates closed.
  const [shown, setShown] = useState<EditConflictEntry | null>(prompt);
  if (prompt && prompt.id !== shown?.id) {
    setShown(prompt);
    setBusy(false);
  }

  const answer = useCallback(
    async (resolution: EditResolution) => {
      if (!shown || busy) return;
      setBusy(true);
      try {
        await resolveEdit(shown.event.editId, resolution);
      } catch (e) {
        // Usually the edit was closed meanwhile.
        toastError("Could not answer the conflict", toIpcError(e).message);
      } finally {
        resolve(shown.id);
        setBusy(false);
      }
    },
    [shown, busy, resolve],
  );
  const saveCopy = useCallback(() => void answer("saveCopy"), [answer]);

  const event = shown?.event;
  if (!event) return null;
  const name = baseName(event.path);
  const folder = parentPath(event.path) ?? event.path;

  return (
    <Modal
      open={prompt !== null}
      title="File changed on the server"
      tone="warning"
      onClose={saveCopy}
      width={500}
      footer={
        <>
          <button
            type="button"
            onClick={() => void answer("discard")}
            disabled={busy || event.remote === null}
            title={
              event.remote === null
                ? "The server copy was deleted; there is nothing to reload"
                : "Reload the server copy into your editor"
            }
          >
            Discard my changes
          </button>
          <button type="button" onClick={saveCopy} disabled={busy}>
            Save as copy
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void answer("overwrite")}
            disabled={busy}
          >
            Overwrite server
          </button>
        </>
      }
    >
      <p className={styles.lead}>
        <strong>{name}</strong> in{" "}
        <span className={prompts.mono}>{folder}</span>{" "}
        {event.remote === null
          ? "was deleted on the server"
          : "was changed on the server"}{" "}
        since you opened it. Your save was not uploaded.
      </p>
      <dl className={styles.sides}>
        <span className={styles.head} />
        <span className={styles.head}>Size</span>
        <span className={styles.head}>Modified</span>
        <Side label="When opened" stamp={event.baseline} />
        <Side label="Server now" stamp={event.remote} />
      </dl>
      <p className={styles.hint}>
        Save as copy uploads your version next to it as {editedName(name)};
        closing this dialog does the same. Discard my changes reloads the server
        copy into your editor.
      </p>
    </Modal>
  );
}

/** `name (edited).ext`, as the core names the copy (when that is free). */
function editedName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? `${name.slice(0, dot)} (edited)${name.slice(dot)}`
    : `${name} (edited)`;
}
