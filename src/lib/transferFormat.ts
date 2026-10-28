/**
 * Display helpers for the transfer panel: speed, ETA, state labels and the
 * live totals over the job list.
 */

import type {
  BatchInfo,
  TransferId,
  TransferJob,
  TransferState,
} from "../ipc/types";
import { formatSize } from "./fileFormat";
import type { StatusTone } from "../components/StatusDot";

/** Nothing will happen to a job in this state any more. */
export function isFinal(state: TransferState): boolean {
  return (
    state === "done" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "skipped"
  );
}

/** "1.5 MB/s"; empty when nothing moves. */
export function formatSpeed(bytesPerSec: number): string {
  if (!(bytesPerSec > 0)) return "";
  return `${formatSize(Math.round(bytesPerSec))}/s`;
}

/** "0:42", "12:05", "1:02:03"; empty when unknown. */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.ceil(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const LABELS: Record<TransferState, string> = {
  queued: "Queued",
  running: "Copying",
  needsDecision: "Needs answer",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

export function stateLabel(state: TransferState): string {
  return LABELS[state];
}

const TONES: Record<TransferState, StatusTone> = {
  queued: "idle",
  running: "busy",
  needsDecision: "warning",
  paused: "warning",
  done: "ok",
  failed: "error",
  cancelled: "idle",
  skipped: "idle",
};

export function stateTone(state: TransferState): StatusTone {
  return TONES[state];
}

export interface TransferTotals {
  /** Bytes of every job except skipped and cancelled ones (as the core counts). */
  totalBytes: number;
  doneBytes: number;
  /** Bytes still to copy by unfinished jobs (what the ETA is about). */
  remainingBytes: number;
  /** Sum of the running jobs' speeds. */
  bytesPerSec: number;
  active: number;
  queued: number;
  needsDecision: number;
  paused: number;
  done: number;
  failed: number;
  /** Jobs in a final state (done, failed, cancelled, skipped). */
  finished: number;
  /** Files to copy (skipped, cancelled and placeholder jobs left out). */
  files: number;
  /** Of those, the ones done. */
  doneFiles: number;
}

/**
 * Totals over `jobs`, the same way the core's `TransferSummary` counts them,
 * but from the per-job progress the events keep current between re-pulls.
 */
export function transferTotals(
  jobs: Iterable<TransferJob>,
  speeds: Record<TransferId, number>,
): TransferTotals {
  const t: TransferTotals = {
    totalBytes: 0,
    doneBytes: 0,
    remainingBytes: 0,
    bytesPerSec: 0,
    active: 0,
    queued: 0,
    needsDecision: 0,
    paused: 0,
    done: 0,
    failed: 0,
    finished: 0,
    files: 0,
    doneFiles: 0,
  };
  for (const job of jobs) {
    if (job.state !== "skipped" && job.state !== "cancelled") {
      t.totalBytes += job.size;
      t.doneBytes += Math.min(job.bytesDone, job.size);
      if (!job.folder) {
        t.files += 1;
        if (job.state === "done") t.doneFiles += 1;
      }
    }
    if (isFinal(job.state)) t.finished += 1;
    else t.remainingBytes += Math.max(0, job.size - job.bytesDone);
    switch (job.state) {
      case "running":
        t.active += 1;
        t.bytesPerSec += speeds[job.id] ?? 0;
        break;
      case "queued":
        t.queued += 1;
        break;
      case "needsDecision":
        t.needsDecision += 1;
        break;
      case "paused":
        t.paused += 1;
        break;
      case "done":
        t.done += 1;
        break;
      case "failed":
        t.failed += 1;
        break;
      default:
        break;
    }
  }
  return t;
}

/** Seconds left at the current speed; `null` when it cannot be told. */
export function etaSeconds(totals: TransferTotals): number | null {
  if (totals.bytesPerSec <= 0 || totals.remainingBytes <= 0) return null;
  return totals.remainingBytes / totals.bytesPerSec;
}

/** "1 transfer" / "3 transfers". */
export function transferCount(n: number): string {
  return n === 1 ? "1 transfer" : `${n} transfers`;
}

/** "2 active · 5 queued · 3.1 MB/s · ETA 0:42", or the finished tally. */
export function summaryText(t: TransferTotals, total: number): string {
  if (total === 0) return "";
  const unfinished = total - t.finished;
  if (unfinished === 0) {
    const parts = [`${t.done} done`];
    if (t.failed > 0) parts.push(`${t.failed} failed`);
    const other = t.finished - t.done - t.failed;
    if (other > 0) parts.push(`${other} skipped or cancelled`);
    return parts.join(" · ");
  }
  const parts = [`${t.active} active`, `${t.queued} queued`];
  if (t.needsDecision > 0) parts.push(`${t.needsDecision} waiting for you`);
  if (t.paused > 0) parts.push(`${t.paused} paused`);
  const speed = formatSpeed(t.bytesPerSec);
  if (speed) parts.push(speed);
  const eta = formatEta(etaSeconds(t));
  if (eta) parts.push(`ETA ${eta}`);
  return parts.join(" · ");
}

/** "1,234" (thousands grouped). */
function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** "1 file" / "1,234 files". */
function files(n: number): string {
  return `${count(n)} ${n === 1 ? "file" : "files"}`;
}

/**
 * "Counting… 1,234 files, 56 MB" over the batches still counting (or
 * "Waiting for the connection…" when every one of them is paused); empty
 * when none is.
 */
export function countingText(batches: BatchInfo[]): string {
  const counting = batches.filter((b) => b.phase === "counting");
  if (counting.length === 0) return "";
  let n = 0;
  let bytes = 0;
  for (const b of counting) {
    n += b.countedFiles;
    bytes += b.countedBytes;
  }
  const lead = counting.every((b) => b.paused)
    ? "Waiting for the connection…"
    : "Counting…";
  return `${lead} ${files(n)}, ${formatSize(bytes)}`;
}

/**
 * The panel header while copying: "12 of 340 files · 3.1 MB of 56 MB ·
 * 1.5 MB/s · ~0:42" (plus what waits for an answer or is paused), or the
 * finished tally. `bytesPerSec` and `etaSecs` are the core's (over every
 * transfer together, so they do not jump as small files come and go).
 */
export function progressText(
  t: TransferTotals,
  total: number,
  bytesPerSec: number,
  etaSecs: number | null,
): string {
  if (total === 0) return "";
  if (total === t.finished) return summaryText(t, total);
  const parts = [
    `${count(t.doneFiles)} of ${files(t.files)}`,
    `${formatSize(t.doneBytes)} of ${formatSize(t.totalBytes)}`,
  ];
  if (t.needsDecision > 0) parts.push(`${t.needsDecision} waiting for you`);
  if (t.paused > 0) parts.push(`${t.paused} paused`);
  const speed = formatSpeed(bytesPerSec > 0 ? bytesPerSec : t.bytesPerSec);
  if (speed) parts.push(speed);
  const eta = formatEta(etaSecs);
  if (eta) parts.push(`~${eta}`);
  return parts.join(" · ");
}
