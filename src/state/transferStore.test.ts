import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listTransfers: vi.fn(),
  enqueueTransfers: vi.fn(),
  cancelTransfer: vi.fn(() => Promise.resolve()),
  cancelBatch: vi.fn(() => Promise.resolve()),
  clearFinished: vi.fn(() => Promise.resolve()),
  retryTransfer: vi.fn(() => Promise.resolve()),
  listDir: vi.fn(() => Promise.resolve([])),
}));
vi.mock("./toastStore", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import {
  cancelBatch,
  cancelTransfer,
  clearFinished,
  enqueueTransfers,
  listDir,
  listTransfers,
  retryTransfer,
} from "../ipc/commands";
import type { BatchInfo, TransferJob, TransferList } from "../ipc/types";
import { useLayoutStore } from "./layoutStore";
import { initialPane, usePaneStore } from "./paneStore";
import { usePromptStore } from "./promptStore";
import { toastError } from "./toastStore";
import {
  EMPTY_SUMMARY,
  RESYNC_MS,
  orderedJobs,
  resetTransferResync,
  unfinishedJobsOf,
  useTransferStore,
} from "./transferStore";

function job(id: string, extra: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
    batchId: "b-1",
    sessionId: "s-1",
    direction: "upload",
    src: `/home/alice/${id}`,
    dst: `/srv/${id}`,
    size: 100,
    bytesDone: 0,
    state: "queued",
    error: null,
    folder: false,
    ...extra,
  };
}

function list(jobs: TransferJob[], batches: BatchInfo[] = []): TransferList {
  return {
    jobs,
    batches,
    summary: { ...EMPTY_SUMMARY, queued: jobs.length },
  };
}

function batch(extra: Partial<BatchInfo> = {}): BatchInfo {
  return {
    batchId: "b-7",
    sessionId: "s-1",
    direction: "download",
    phase: "counting",
    paused: false,
    countedFiles: 0,
    countedBytes: 0,
    countedFolders: 0,
    totalFiles: 0,
    totalBytes: 0,
    doneFiles: 0,
    doneBytes: 0,
    ...extra,
  };
}

const store = () => useTransferStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  resetTransferResync();
  useTransferStore.setState({
    jobs: {},
    order: [],
    batches: [],
    summary: EMPTY_SUMMARY,
    speeds: {},
  });
  usePromptStore.setState({ queue: [] });
  usePaneStore.setState({
    panes: {
      local: { ...initialPane(), target: { kind: "local" }, path: "/home" },
      remote: {
        ...initialPane(),
        target: { kind: "remote", sessionId: "s-1" },
        path: "/srv",
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("transferStore", () => {
  it("re-pulls the list in discovery order", async () => {
    vi.mocked(listTransfers).mockResolvedValue(list([job("a"), job("b")]));
    await store().resync();
    expect(orderedJobs(store()).map((j) => j.id)).toEqual(["a", "b"]);
    expect(store().summary.queued).toBe(2);
  });

  it("merges progress and keeps running byte counts from going back", async () => {
    useTransferStore.setState({
      jobs: { a: job("a", { state: "running" }) },
      order: ["a"],
    });
    store().applyProgress({
      type: "transferProgress",
      jobId: "a",
      batchId: "b-1",
      bytesDone: 60,
      size: 100,
      bytesPerSec: 30,
    });
    expect(store().jobs.a.bytesDone).toBe(60);
    expect(store().speeds.a).toBe(30);

    // An older answer from the core still says 20 bytes.
    vi.mocked(listTransfers).mockResolvedValue(
      list([job("a", { state: "running", bytesDone: 20 })]),
    );
    await store().resync();
    expect(store().jobs.a.bytesDone).toBe(60);
    expect(store().speeds.a).toBe(30);
  });

  it("throttles re-pulls after job changes", async () => {
    vi.useFakeTimers();
    vi.mocked(listTransfers).mockResolvedValue(list([job("a")]));
    store().applyJob(job("a", { state: "running" }));
    store().applyJob(job("a", { state: "running", bytesDone: 5 }));
    store().scheduleResync();
    expect(listTransfers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RESYNC_MS);
    expect(listTransfers).toHaveBeenCalledTimes(1);
  });

  it("re-pulls when progress names a job it does not know yet", async () => {
    vi.useFakeTimers();
    vi.mocked(listTransfers).mockResolvedValue(list([job("z")]));
    store().applyProgress({
      type: "transferProgress",
      jobId: "z",
      batchId: "b-1",
      bytesDone: 1,
      size: 100,
      bytesPerSec: 1,
    });
    await vi.advanceTimersByTimeAsync(RESYNC_MS);
    expect(store().jobs.z).toBeDefined();
  });

  it("refreshes the destination pane when a batch's last job finishes", () => {
    useTransferStore.setState({
      jobs: {
        a: job("a", { state: "done" }),
        b: job("b", { state: "running" }),
      },
      order: ["a", "b"],
    });
    store().applyJob(job("b", { state: "done" }));
    expect(listDir).toHaveBeenCalledWith(
      { kind: "remote", sessionId: "s-1" },
      "/srv",
    );
    expect(listDir).toHaveBeenCalledTimes(1);
  });

  it("refreshes the local pane after a download, not while one job is left", () => {
    useTransferStore.setState({
      jobs: {
        a: job("a", { direction: "download", state: "running" }),
        b: job("b", { direction: "download", state: "queued" }),
      },
      order: ["a", "b"],
    });
    store().applyJob(job("a", { direction: "download", state: "failed" }));
    expect(listDir).not.toHaveBeenCalled();
    store().applyJob(job("b", { direction: "download", state: "done" }));
    expect(listDir).toHaveBeenCalledWith({ kind: "local" }, "/home");
  });

  it("drops a queued conflict once its job no longer waits", () => {
    usePromptStore.getState().push({
      kind: "transferConflict",
      event: {
        type: "transferConflict",
        batchId: "b-1",
        jobId: "a",
        src: { path: "/home/alice/a", size: 10, mtime: null },
        dst: { path: "/srv/a", size: 5, mtime: null },
      },
    });
    store().applyJob(job("a", { state: "needsDecision" }));
    expect(usePromptStore.getState().queue).toHaveLength(1);
    store().applyJob(job("a", { state: "cancelled" }));
    expect(usePromptStore.getState().queue).toHaveLength(0);
  });

  it("enqueues, opens the panel and reports a failure", async () => {
    useLayoutStore.setState({ transfersCollapsed: true });
    vi.mocked(enqueueTransfers).mockResolvedValue("b-9");
    const request = {
      sessionId: "s-1",
      direction: "upload" as const,
      items: [{ src: "/home/alice/a" }],
      dstDir: "/srv",
    };
    await expect(store().enqueue(request)).resolves.toBe("b-9");
    expect(enqueueTransfers).toHaveBeenCalledWith(request);
    expect(useLayoutStore.getState().transfersCollapsed).toBe(false);

    vi.mocked(enqueueTransfers).mockRejectedValue({
      kind: "invalidInput",
      message: "nothing to transfer",
    });
    await expect(store().enqueue(request)).resolves.toBeNull();
    expect(toastError).toHaveBeenCalledWith(
      "Could not start the upload",
      "nothing to transfer",
    );
  });

  it("cancels one job, every unfinished batch, and clears finished ones", async () => {
    vi.mocked(listTransfers).mockResolvedValue(list([]));
    useTransferStore.setState({
      jobs: {
        a: job("a", { state: "running" }),
        b: job("b", { batchId: "b-2", state: "queued" }),
        c: job("c", { batchId: "b-3", state: "done" }),
      },
      order: ["a", "b", "c"],
    });
    await store().cancel("a");
    expect(cancelTransfer).toHaveBeenCalledWith("a");
    await store().cancelAll();
    expect(vi.mocked(cancelBatch).mock.calls.map(([b]) => b)).toEqual([
      "b-1",
      "b-2",
    ]);
    await store().clearFinished();
    expect(clearFinished).toHaveBeenCalled();
    expect(store().order).toEqual([]);
  });

  it("retries a failed job and reports why it could not", async () => {
    await useTransferStore.getState().retry("j-1");
    expect(retryTransfer).toHaveBeenCalledWith("j-1");
    expect(toastError).not.toHaveBeenCalled();
    vi.mocked(retryTransfer).mockRejectedValueOnce({
      kind: "notConnected",
      message: "not connected",
    });
    await useTransferStore.getState().retry("j-1");
    expect(toastError).toHaveBeenCalledWith(
      "Could not retry the transfer",
      "not connected",
    );
  });

  it("keeps the batches and moves a counting one's numbers", async () => {
    vi.mocked(listTransfers).mockResolvedValueOnce(list([], [batch()]));
    await store().resync();
    expect(store().batches).toHaveLength(1);
    store().applyCounting({
      type: "batchCounting",
      batchId: "b-7",
      files: 12,
      bytes: 3400,
      folders: 2,
    });
    expect(store().batches[0]).toMatchObject({
      countedFiles: 12,
      countedBytes: 3400,
      countedFolders: 2,
    });
    // Cancel all also stops a batch that has no jobs yet.
    await store().cancelAll();
    expect(cancelBatch).toHaveBeenCalledWith("b-7");
  });

  it("re-pulls when an unknown batch is counting", () => {
    vi.useFakeTimers();
    vi.mocked(listTransfers).mockResolvedValue(list([]));
    store().applyCounting({
      type: "batchCounting",
      batchId: "b-new",
      files: 1,
      bytes: 1,
      folders: 0,
    });
    vi.advanceTimersByTime(RESYNC_MS);
    expect(listTransfers).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("lists a session's unfinished jobs", () => {
    const jobs = {
      a: job("a", { state: "paused" }),
      b: job("b", { state: "done" }),
      c: job("c", { state: "queued", sessionId: "s-other" }),
    };
    expect(unfinishedJobsOf(jobs, "s-1").map((j) => j.id)).toEqual(["a"]);
  });
});
