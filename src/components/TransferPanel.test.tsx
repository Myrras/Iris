import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  cancelTransfer: vi.fn(() => Promise.resolve()),
  cancelBatch: vi.fn(() => Promise.resolve()),
  clearFinished: vi.fn(() => Promise.resolve()),
  retryTransfer: vi.fn(() => Promise.resolve()),
  listTransfers: vi.fn(() =>
    Promise.resolve({ jobs: [], summary: EMPTY_SUMMARY }),
  ),
}));

import {
  cancelBatch,
  cancelTransfer,
  clearFinished,
  retryTransfer,
} from "../ipc/commands";
import type { BatchInfo, TransferJob } from "../ipc/types";
import { summaryText, transferTotals } from "../lib/transferFormat";
import { useLayoutStore } from "../state/layoutStore";
import {
  EMPTY_SUMMARY,
  resetTransferResync,
  useTransferStore,
} from "../state/transferStore";
import { stubViewport } from "../test/viewport";
import { TransferPanel } from "./TransferPanel";

stubViewport();

function job(id: string, extra: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
    batchId: "b-1",
    sessionId: "s-1",
    direction: "upload",
    src: `/home/alice/${id}.txt`,
    dst: `/srv/${id}.txt`,
    size: 2048,
    bytesDone: 0,
    state: "queued",
    error: null,
    folder: false,
    ...extra,
  };
}

function setJobs(jobs: TransferJob[], speeds: Record<string, number> = {}) {
  useTransferStore.setState({
    jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
    order: jobs.map((j) => j.id),
    speeds,
  });
}

function countingBatch(extra: Partial<BatchInfo> = {}): BatchInfo {
  return {
    batchId: "b-9",
    sessionId: "s-1",
    direction: "upload",
    phase: "counting",
    paused: false,
    countedFiles: 1234,
    countedBytes: 56 * 1024 * 1024,
    countedFolders: 40,
    totalFiles: 0,
    totalBytes: 0,
    doneFiles: 0,
    doneBytes: 0,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTransferResync();
  localStorage.clear();
  useLayoutStore.setState({ transfersCollapsed: false });
  setJobs([]);
  useTransferStore.setState({ batches: [], summary: EMPTY_SUMMARY });
});

describe("TransferPanel", () => {
  it("shows the empty queue placeholder", () => {
    render(<TransferPanel />);

    expect(screen.getByText(/No transfers yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transfers" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("collapses and remembers it", () => {
    render(<TransferPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transfers" }));
    expect(screen.getByRole("button", { name: "Transfers" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(useLayoutStore.getState().transfersCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem("iris.layout") ?? "{}")).toEqual(
      expect.objectContaining({ transfersCollapsed: true }),
    );
  });

  it("lists jobs with progress, speed and state", () => {
    setJobs(
      [
        job("a", { state: "running", bytesDone: 1024 }),
        job("b", { direction: "download" }),
        job("c", {
          state: "failed",
          error: { kind: "permissionDenied", message: "Permission denied" },
        }),
      ],
      { a: 1536 },
    );
    useTransferStore.setState({ summary: { ...EMPTY_SUMMARY, etaSecs: 2 } });
    render(<TransferPanel />);

    const a = screen.getByRole("listitem", { name: "a.txt" });
    expect(within(a).getByText("a.txt")).toHaveAttribute(
      "title",
      "/home/alice/a.txt → /srv/a.txt",
    );
    expect(within(a).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(within(a).getByText("1.0 KB / 2.0 KB")).toBeInTheDocument();
    expect(within(a).getByText("1.5 KB/s")).toBeInTheDocument();
    expect(within(a).getByText("Copying")).toBeInTheDocument();

    const b = screen.getByRole("listitem", { name: "b.txt" });
    expect(
      within(b).getByRole("img", { name: "Download" }),
    ).toBeInTheDocument();

    const c = screen.getByRole("listitem", { name: "c.txt" });
    expect(
      within(c).getByRole("img", { name: "Failed: Permission denied" }),
    ).toBeInTheDocument();
    // A finished job has nothing to cancel.
    expect(
      within(c).queryByRole("button", { name: "Cancel c.txt" }),
    ).not.toBeInTheDocument();

    expect(
      screen.getByText("0 of 3 files · 1.0 KB of 6.0 KB · 1.5 KB/s · ~0:02"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Total progress" }),
    ).toHaveAttribute("aria-valuenow", "17");
  });

  it("counts a batch first, with a sliding bar and no ETA", () => {
    useTransferStore.setState({
      batches: [countingBatch()],
      summary: { ...EMPTY_SUMMARY, etaSecs: 99 },
    });
    render(<TransferPanel />);
    expect(
      screen.getByText("Counting… 1,234 files, 56.0 MB"),
    ).toBeInTheDocument();
    expect(screen.getByText(/starts once everything is counted/)).toBeVisible();
    const bar = screen.getByRole("progressbar", { name: "Total progress" });
    expect(bar).not.toHaveAttribute("aria-valuenow");
    // Counting can be cancelled before any job exists.
    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    expect(cancelBatch).toHaveBeenCalledWith("b-9");
  });

  it("says when a count waits for the connection", () => {
    useTransferStore.setState({ batches: [countingBatch({ paused: true })] });
    render(<TransferPanel />);
    expect(
      screen.getByText("Waiting for the connection… 1,234 files, 56.0 MB"),
    ).toBeInTheDocument();
  });

  it("cancels a job, cancels all and clears finished", () => {
    setJobs([
      job("a", { state: "running" }),
      job("b", { batchId: "b-2", state: "done", bytesDone: 2048 }),
    ]);
    render(<TransferPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel a.txt" }));
    expect(cancelTransfer).toHaveBeenCalledWith("a");

    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    expect(cancelBatch).toHaveBeenCalledWith("b-1");
    expect(cancelBatch).not.toHaveBeenCalledWith("b-2");

    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(clearFinished).toHaveBeenCalled();
  });

  it("retries a failed job, and only a failed one", () => {
    setJobs([
      job("broken", {
        state: "failed",
        error: { kind: "permissionDenied", message: "permission denied: /srv" },
      }),
      job("fine", { state: "done", bytesDone: 2048 }),
    ]);
    render(<TransferPanel />);
    expect(
      screen.queryByRole("button", { name: "Retry fine.txt" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel broken.txt" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry broken.txt" }));
    expect(retryTransfer).toHaveBeenCalledWith("broken");
  });

  it("shows a folder that could not be listed as a folder row", () => {
    setJobs([
      job("photos", {
        src: "/home/alice/photos",
        dst: "/srv/photos",
        size: 0,
        state: "failed",
        folder: true,
      }),
    ]);
    render(<TransferPanel />);
    const row = screen.getByRole("listitem", { name: "photos" });
    expect(
      within(row).getByRole("img", { name: "Folder, not listed yet" }),
    ).toBeInTheDocument();
    expect(row).toHaveTextContent("folder");
  });

  it("virtualises long queues", () => {
    setJobs(Array.from({ length: 1000 }, (_, i) => job(`f${i}`)));
    render(<TransferPanel />);

    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
  });

  it("summarises a finished queue", () => {
    const jobs = [
      job("a", { state: "done", bytesDone: 2048 }),
      job("b", { state: "failed" }),
      job("c", { state: "skipped" }),
    ];
    expect(summaryText(transferTotals(jobs, {}), jobs.length)).toBe(
      "1 done · 1 failed · 1 skipped or cancelled",
    );
  });
});
