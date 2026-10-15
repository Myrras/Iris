/**
 * A transfer's destination already exists: Replace, Skip, Keep Both or
 * Resume, optionally for every remaining conflict of the same transfer.
 * In the look of Selene's ConflictModal (warning modal, bold file name lead,
 * muted hint), with the two sides' size and date compared in a facts grid.
 *
 * Driven by the prompt queue (`transfer:conflict` → `promptStore`), one at a
 * time. Closing it (Escape, overlay, ✕) answers Skip — the answer that
 * leaves both files alone. With "apply to all" the backend decides the
 * batch's other conflicts itself, so their queued prompts are dropped.
 */

import { useCallback, useState } from "react";

import { resolveConflict, toIpcError } from "../ipc/commands";
import type { ConflictResolution, ConflictSide } from "../ipc/types";
import { formatModifiedFull } from "../lib/dateFormat";
import { formatSize } from "../lib/fileFormat";
import { baseName, parentPath } from "../lib/path";
import { usePromptStore, type Prompt } from "../state/promptStore";
import { toastError } from "../state/toastStore";
import { useTransferStore } from "../state/transferStore";
import { Modal } from "./Modal";
import styles from "./ConflictDialog.module.css";
import prompts from "./Prompts.module.css";

type ConflictEntry = Extract<Prompt, { kind: "transferConflict" }>;

function Side({
  label,
  side,
  newer,
}: {
  label: string;
  side: ConflictSide;
  newer: boolean;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={styles.size}>{formatSize(side.size)}</dd>
      <dd className={styles.date} title={side.path}>
        {formatModifiedFull(side.mtime) || "Unknown date"}
        {newer && <span className={styles.badge}>newer</span>}
      </dd>
    </>
  );
}

export function ConflictDialog({ prompt }: { prompt: ConflictEntry | null }) {
  const resolve = usePromptStore((s) => s.resolve);
  const [busy, setBusy] = useState(false);
  const [applyToAll, setApplyToAll] = useState(false);
  // Keep the last prompt on screen while the dialog animates closed.
  const [shown, setShown] = useState<ConflictEntry | null>(prompt);
  if (prompt && prompt.id !== shown?.id) {
    setShown(prompt);
    setBusy(false);
    setApplyToAll(false);
  }

  const event = shown?.event;
  const direction = useTransferStore((s) =>
    event ? s.jobs[event.jobId]?.direction : undefined,
  );

  const answer = useCallback(
    async (resolution: ConflictResolution) => {
      if (!shown || busy) return;
      setBusy(true);
      const { jobId, batchId } = shown.event;
      try {
        await resolveConflict(jobId, resolution, applyToAll);
      } catch (e) {
        // Usually the job was cancelled meanwhile.
        toastError("Could not answer the conflict", toIpcError(e).message);
      } finally {
        resolve(shown.id);
        if (applyToAll) usePromptStore.getState().dropTransferBatch(batchId);
        setBusy(false);
      }
    },
    [shown, busy, applyToAll, resolve],
  );
  const skip = useCallback(() => void answer("skip"), [answer]);

  if (!event) return null;
  const name = baseName(event.dst.path);
  const folder = parentPath(event.dst.path) ?? event.dst.path;
  const canResume = event.dst.size < event.src.size;
  const srcNewer =
    event.src.mtime !== null &&
    event.dst.mtime !== null &&
    event.src.mtime > event.dst.mtime;
  const dstNewer =
    event.src.mtime !== null &&
    event.dst.mtime !== null &&
    event.dst.mtime > event.src.mtime;
  const where =
    direction === "upload"
      ? { src: "Local", dst: "Remote" }
      : direction === "download"
        ? { src: "Remote", dst: "Local" }
        : { src: "Copying", dst: "Existing" };

  return (
    <Modal
      open={prompt !== null}
      title="File already exists"
      tone="warning"
      onClose={skip}
      width={500}
      footer={
        <>
          <button type="button" onClick={skip} disabled={busy}>
            Skip
          </button>
          <button
            type="button"
            onClick={() => void answer("keepBoth")}
            disabled={busy}
          >
            Keep Both
          </button>
          <button
            type="button"
            onClick={() => void answer("resume")}
            disabled={busy || !canResume}
            title={
              canResume
                ? "Copy the rest onto the existing, shorter file"
                : "Only a destination smaller than the source can be resumed"
            }
          >
            Resume
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void answer("replace")}
            disabled={busy}
          >
            Replace
          </button>
        </>
      }
    >
      <p className={styles.lead}>
        <strong>{name}</strong> already exists in{" "}
        <span className={prompts.mono}>{folder}</span>.
      </p>
      <dl className={styles.sides}>
        <span className={styles.head} />
        <span className={styles.head}>Size</span>
        <span className={styles.head}>Modified</span>
        <Side label={where.src} side={event.src} newer={srcNewer} />
        <Side label={where.dst} side={event.dst} newer={dstNewer} />
      </dl>
      <p className={styles.hint}>
        Keep Both saves the copy under a numbered name. Resume continues a
        partial copy.
      </p>
      <label className={prompts.toggle}>
        <input
          type="checkbox"
          checked={applyToAll}
          onChange={(e) => setApplyToAll(e.target.checked)}
        />
        <span>Apply to all remaining conflicts in this transfer</span>
      </label>
    </Modal>
  );
}
