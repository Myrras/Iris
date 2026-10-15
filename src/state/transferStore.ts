/**
 * The transfer queue as the frontend sees it: every job by id (in discovery
 * order), the core's summary, and each running job's speed.
 *
 * Fed by `useCoreEvents`: `transfer:job-changed` replaces one job,
 * `transfer:progress` moves its byte count, and both `transfers:updated` and
 * job changes schedule a re-pull of `listTransfers` (throttled to
 * `RESYNC_MS`), so the list converges on the core even when events were
 * dropped. Between re-pulls the panel computes live totals from the per-job
 * progress (`transferTotals`).
 *
 * When the last unfinished job of a batch finishes, the destination pane is
 * re-read so the copied files show up.
 */

import { create } from "zustand";

import {
  cancelBatch as cancelBatchCmd,
  cancelTransfer,
  clearFinished as clearFinishedCmd,
  enqueueTransfers,
  listTransfers,
  retryTransfer,
  toIpcError,
} from "../ipc/commands";
import type {
  BatchId,
  SessionId,
  TransferId,
  TransferJob,
  TransferProgressEvent,
  TransferRequest,
  TransferSummary,
} from "../ipc/types";
import { isFinal } from "../lib/transferFormat";
import { useLayoutStore } from "./layoutStore";
import { usePaneStore, type PaneId } from "./paneStore";
import { usePromptStore } from "./promptStore";
import { toastError } from "./toastStore";

/** At most four re-pulls of the list a second. */
export const RESYNC_MS = 250;

export const EMPTY_SUMMARY: TransferSummary = {
  totalBytes: 0,
  doneBytes: 0,
  bytesPerSec: 0,
  active: 0,
  queued: 0,
  needsDecision: 0,
  paused: 0,
};

interface TransferStoreState {
  jobs: Record<TransferId, TransferJob>;
  /** Job ids in the order the core found them. */
  order: TransferId[];
  summary: TransferSummary;
  /** Bytes per second of each running job, from `transfer:progress`. */
  speeds: Record<TransferId, number>;

  /** Re-pull the whole list now. */
  resync: () => Promise<void>;
  /** Re-pull soon (coalesces bursts to one call per `RESYNC_MS`). */
  scheduleResync: () => void;
  /** `transfer:job-changed`. */
  applyJob: (job: TransferJob) => void;
  /** `transfer:progress`. */
  applyProgress: (event: TransferProgressEvent) => void;

  /** Queue a transfer; opens the panel. Resolves with the batch id, or `null`. */
  enqueue: (request: TransferRequest) => Promise<BatchId | null>;
  cancel: (jobId: TransferId) => Promise<void>;
  /** Queue a failed job again (a file starts over, a folder is re-listed). */
  retry: (jobId: TransferId) => Promise<void>;
  cancelBatch: (batchId: BatchId) => Promise<void>;
  /** Cancel every batch that still has unfinished jobs. */
  cancelAll: () => Promise<void>;
  clearFinished: () => Promise<void>;
}

let resyncTimer: ReturnType<typeof setTimeout> | null = null;
/** Latest `listTransfers` call; an older answer is dropped on arrival. */
let resyncToken = 0;

/**
 * Batches that had unfinished jobs in `prev` and have none left in `next`
 * (one job each, which says where the batch copied to).
 */
function settledBatches(
  prev: Record<TransferId, TransferJob>,
  next: Record<TransferId, TransferJob>,
): TransferJob[] {
  const wasBusy = new Set<BatchId>();
  for (const job of Object.values(prev)) {
    if (!isFinal(job.state)) wasBusy.add(job.batchId);
  }
  if (wasBusy.size === 0) return [];
  const stillBusy = new Set<BatchId>();
  const sample = new Map<BatchId, TransferJob>();
  for (const job of Object.values(next)) {
    if (!wasBusy.has(job.batchId)) continue;
    if (!isFinal(job.state)) stillBusy.add(job.batchId);
    else if (!sample.has(job.batchId)) sample.set(job.batchId, job);
  }
  return [...sample.entries()]
    .filter(([batchId]) => !stillBusy.has(batchId))
    .map(([, job]) => job);
}

/** Re-read the pane a finished batch copied into, if it still shows that side. */
function refreshDestinations(settled: TransferJob[]) {
  const panes = new Set<PaneId>();
  const { panes: state } = usePaneStore.getState();
  for (const job of settled) {
    if (job.direction === "download") {
      panes.add("local");
    } else {
      const target = state.remote.target;
      if (target?.kind === "remote" && target.sessionId === job.sessionId) {
        panes.add("remote");
      }
    }
  }
  for (const pane of panes) void usePaneStore.getState().refresh(pane);
}

/** Toast a failed command, except a lost session (the pane shows that). */
function failed(title: string, e: unknown) {
  const err = toIpcError(e);
  if (err.kind !== "notConnected") toastError(title, err.message);
}

export const useTransferStore = create<TransferStoreState>((set, get) => ({
  jobs: {},
  order: [],
  summary: EMPTY_SUMMARY,
  speeds: {},

  resync: async () => {
    const token = ++resyncToken;
    let list;
    try {
      list = await listTransfers();
    } catch (e) {
      if (token === resyncToken) failed("Could not load the transfers", e);
      return;
    }
    if (token !== resyncToken || !list) return;
    const prev = get().jobs;
    const jobs: Record<TransferId, TransferJob> = {};
    for (const job of list.jobs) {
      // A progress event can be newer than this answer: never move a running
      // job's byte count backwards.
      const known = prev[job.id];
      jobs[job.id] =
        known &&
        known.state === "running" &&
        job.state === "running" &&
        known.bytesDone > job.bytesDone
          ? { ...job, bytesDone: known.bytesDone }
          : job;
    }
    const speeds: Record<TransferId, number> = {};
    for (const [id, speed] of Object.entries(get().speeds)) {
      if (jobs[id]?.state === "running") speeds[id] = speed;
    }
    set({
      jobs,
      order: list.jobs.map((j) => j.id),
      summary: list.summary,
      speeds,
    });
    // Conflicts of jobs that are gone or finished can no longer be answered.
    // (Not of jobs merely not `needsDecision` here: this answer may predate
    // the conflict event.)
    for (const prompt of usePromptStore.getState().queue) {
      if (prompt.kind !== "transferConflict") continue;
      const job = jobs[prompt.event.jobId];
      if (!job || isFinal(job.state)) {
        usePromptStore.getState().dropTransferJob(prompt.event.jobId);
      }
    }
    refreshDestinations(settledBatches(prev, jobs));
  },

  scheduleResync: () => {
    if (resyncTimer !== null) return;
    resyncTimer = setTimeout(() => {
      resyncTimer = null;
      void get().resync();
    }, RESYNC_MS);
  },

  applyJob: (job) => {
    const prev = get().jobs;
    const jobs = { ...prev, [job.id]: job };
    const known = job.id in prev;
    const speeds = { ...get().speeds };
    if (job.state !== "running") delete speeds[job.id];
    set({
      jobs,
      order: known ? get().order : [...get().order, job.id],
      speeds,
    });
    if (job.state !== "needsDecision") {
      usePromptStore.getState().dropTransferJob(job.id);
    }
    refreshDestinations(settledBatches(prev, jobs));
    // The summary has no event of its own.
    get().scheduleResync();
  },

  applyProgress: ({ jobId, bytesDone, size, bytesPerSec }) => {
    const job = get().jobs[jobId];
    if (!job) {
      // Found by a folder expansion we have not pulled yet.
      get().scheduleResync();
      return;
    }
    set({
      jobs: { ...get().jobs, [jobId]: { ...job, bytesDone, size } },
      speeds: { ...get().speeds, [jobId]: bytesPerSec },
    });
  },

  enqueue: async (request) => {
    let batchId: BatchId;
    try {
      batchId = await enqueueTransfers(request);
    } catch (e) {
      failed(
        request.direction === "upload"
          ? "Could not start the upload"
          : "Could not start the download",
        e,
      );
      return null;
    }
    // A new batch opens the panel; otherwise its collapse state is the user's.
    useLayoutStore.getState().setTransfersCollapsed(false);
    get().scheduleResync();
    return batchId;
  },

  cancel: async (jobId) => {
    try {
      await cancelTransfer(jobId);
    } catch (e) {
      failed("Could not cancel the transfer", e);
    }
    get().scheduleResync();
  },

  retry: async (jobId) => {
    try {
      await retryTransfer(jobId);
    } catch (e) {
      // Asked for explicitly, so even a lost session is worth saying.
      toastError("Could not retry the transfer", toIpcError(e).message);
    }
    get().scheduleResync();
  },

  cancelBatch: async (batchId) => {
    try {
      await cancelBatchCmd(batchId);
    } catch (e) {
      failed("Could not cancel the transfers", e);
    }
    get().scheduleResync();
  },

  cancelAll: async () => {
    const batches = new Set<BatchId>();
    for (const job of Object.values(get().jobs)) {
      if (!isFinal(job.state)) batches.add(job.batchId);
    }
    for (const batchId of batches) {
      try {
        await cancelBatchCmd(batchId);
      } catch (e) {
        failed("Could not cancel the transfers", e);
      }
    }
    get().scheduleResync();
  },

  clearFinished: async () => {
    try {
      await clearFinishedCmd();
    } catch (e) {
      failed("Could not clear the finished transfers", e);
    }
    await get().resync();
  },
}));

/** Test hook: forget a pending throttled re-pull. */
export function resetTransferResync(): void {
  if (resyncTimer !== null) clearTimeout(resyncTimer);
  resyncTimer = null;
  resyncToken += 1;
}

/** The jobs in discovery order. */
export function orderedJobs(state: {
  jobs: Record<TransferId, TransferJob>;
  order: TransferId[];
}): TransferJob[] {
  const out: TransferJob[] = [];
  for (const id of state.order) {
    const job = state.jobs[id];
    if (job) out.push(job);
  }
  return out;
}

/**
 * The unfinished (queued, running, waiting or paused) jobs of a session:
 * what a disconnect would cancel.
 */
export function unfinishedJobsOf(
  jobs: Record<TransferId, TransferJob>,
  sessionId: SessionId,
): TransferJob[] {
  return Object.values(jobs).filter(
    (job) => job.sessionId === sessionId && !isFinal(job.state),
  );
}
