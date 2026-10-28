/**
 * Asks before closing a tab, or disconnecting its session, while that
 * session still has unfinished transfers: a disconnect cancels them (the
 * session id is gone, so they could never resume). In the style of
 * `CloseWarningModal`. Opened by `tabsStore.pending` (`lib/tabs`).
 */

import { useMemo, useRef } from "react";

import { confirmPending } from "../lib/tabs";
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

export function TabCloseModal() {
  const pending = useTabsStore((s) => s.pending);
  const tab = useTabsStore((s) =>
    s.tabs.find((t) => t.id === s.pending?.tabId),
  );
  const profiles = useProfilesStore((s) => s.profiles);
  const jobs = useTransferStore((s) => s.jobs);
  const batches = useTransferStore((s) => s.batches);
  const sessionId = tab?.sessionId ?? null;
  const counting = countingBatches(batches).filter(
    (b) => b.sessionId === sessionId,
  ).length;
  const totals = useMemo(
    () =>
      transferTotals(sessionId ? unfinishedJobsOf(jobs, sessionId) : [], {}),
    [jobs, sessionId],
  );
  // Keep the wording while the dialog animates out after `pending` clears.
  const last = useRef({ name: "", close: true });
  if (pending && tab) {
    last.current = {
      name: profiles.find((p) => p.id === tab.profileId)?.name ?? tab.title,
      close: pending.action === "close",
    };
  }
  const { name, close } = last.current;
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
      open={pending !== null && tab !== undefined}
      title={close ? "Close tab?" : "Disconnect?"}
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
            {close ? "Close tab" : "Disconnect"}
          </button>
        </>
      }
    >
      <p className={styles.intro}>
        {`${transferCount(unfinished)} of ${name} will be cancelled if you ${
          close ? "close this tab" : "disconnect"
        } now. Partly copied files stay where they are.`}
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
