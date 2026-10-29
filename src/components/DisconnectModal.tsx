/**
 * Asks before disconnecting a connection while its session still has
 * unfinished transfers: a disconnect cancels them (the session id is gone,
 * so they could never resume). In the style of `CloseWarningModal`. Opened
 * by `tabsStore.pending` (`lib/connections`).
 */

import { useMemo, useRef } from "react";

import { confirmPending } from "../lib/connections";
import { transferCount, transferTotals } from "../lib/transferFormat";
import { useProfilesStore } from "../state/profilesStore";
import { useTabsStore } from "../state/tabsStore";
import {
  countingBatches,
  unfinishedJobsOf,
  useTransferStore,
} from "../state/transferStore";
import { Modal } from "./Modal";
import { StatusDot } from "./StatusDot";
import styles from "./CloseWarningModal.module.css";

export function DisconnectModal() {
  const pending = useTabsStore((s) => s.pending);
  const connection = useTabsStore((s) =>
    s.pending ? s.connections[s.pending.profileId] : undefined,
  );
  const profiles = useProfilesStore((s) => s.profiles);
  const jobs = useTransferStore((s) => s.jobs);
  const batches = useTransferStore((s) => s.batches);
  const sessionId = connection?.sessionId ?? null;
  const counting = countingBatches(batches).filter(
    (b) => b.sessionId === sessionId,
  ).length;
  const totals = useMemo(
    () =>
      transferTotals(sessionId ? unfinishedJobsOf(jobs, sessionId) : [], {}),
    [jobs, sessionId],
  );
  // Keep the wording while the dialog animates out after `pending` clears.
  const last = useRef("");
  if (pending && connection) {
    last.current =
      profiles.find((p) => p.id === connection.profileId)?.name ??
      "this connection";
  }
  const name = last.current;
  const cancel = () => useTabsStore.getState().setPending(null);

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
    {
      n: counting,
      text: counting === 1 ? "folder still counting" : "folders still counting",
      tone: "busy" as const,
    },
  ].filter((l) => l.n > 0);

  return (
    <Modal
      open={pending !== null && connection !== undefined}
      title="Disconnect?"
      tone="warning"
      onClose={cancel}
      footer={
        <>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void confirmPending()}
          >
            Disconnect
          </button>
        </>
      }
    >
      <p className={styles.intro}>
        {`${transferCount(unfinished)} of ${name} will be cancelled if you disconnect now. Partly copied files stay where they are.`}
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
