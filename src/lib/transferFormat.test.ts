import { describe, expect, it } from "vitest";

import type { BatchInfo, TransferJob } from "../ipc/types";
import {
  countingText,
  etaSeconds,
  formatEta,
  formatSpeed,
  isFinal,
  progressText,
  stateLabel,
  stateTone,
  transferCount,
  transferTotals,
} from "./transferFormat";

function job(id: string, extra: Partial<TransferJob> = {}): TransferJob {
  return {
    id,
    batchId: "b-1",
    sessionId: "s-1",
    direction: "upload",
    src: `/src/${id}`,
    dst: `/dst/${id}`,
    size: 100,
    bytesDone: 0,
    state: "queued",
    error: null,
    folder: false,
    ...extra,
  };
}

describe("transferFormat", () => {
  it("formats speed and ETA", () => {
    expect(formatSpeed(0)).toBe("");
    expect(formatSpeed(1536)).toBe("1.5 KB/s");
    expect(formatEta(null)).toBe("");
    expect(formatEta(41.2)).toBe("0:42");
    expect(formatEta(725)).toBe("12:05");
    expect(formatEta(3723)).toBe("1:02:03");
  });

  it("labels and tones every state", () => {
    expect(stateLabel("running")).toBe("Copying");
    expect(stateTone("failed")).toBe("error");
    expect(stateTone("done")).toBe("ok");
    expect(isFinal("skipped")).toBe(true);
    expect(isFinal("paused")).toBe(false);
    expect(transferCount(1)).toBe("1 transfer");
    expect(transferCount(2)).toBe("2 transfers");
  });

  it("totals jobs like the core summary, with live speeds", () => {
    const totals = transferTotals(
      [
        job("a", { state: "running", bytesDone: 40 }),
        job("b", { state: "queued" }),
        job("c", { state: "done", bytesDone: 100 }),
        job("d", { state: "cancelled", bytesDone: 10 }),
        job("e", { state: "needsDecision" }),
        job("f", { state: "failed", error: { kind: "io", message: "x" } }),
      ],
      { a: 20, c: 99 },
    );
    expect(totals).toMatchObject({
      totalBytes: 500,
      doneBytes: 140,
      remainingBytes: 260,
      bytesPerSec: 20,
      active: 1,
      queued: 1,
      needsDecision: 1,
      done: 1,
      failed: 1,
      finished: 3,
    });
    expect(etaSeconds(totals)).toBe(13);
    expect(etaSeconds({ ...totals, bytesPerSec: 0 })).toBeNull();
  });
});

function batch(extra: Partial<BatchInfo> = {}): BatchInfo {
  return {
    batchId: "b-1",
    sessionId: "s-1",
    direction: "upload",
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

describe("counting and progress text", () => {
  it("adds up the batches still counting", () => {
    expect(countingText([])).toBe("");
    expect(countingText([batch({ phase: "transferring" })])).toBe("");
    expect(
      countingText([
        batch({ countedFiles: 1000, countedBytes: 50 * 1024 * 1024 }),
        batch({
          batchId: "b-2",
          countedFiles: 234,
          countedBytes: 6 * 1024 * 1024,
        }),
      ]),
    ).toBe("Counting… 1,234 files, 56.0 MB");
    expect(countingText([batch({ paused: true, countedFiles: 1 })])).toBe(
      "Waiting for the connection… 1 file, 0 B",
    );
  });

  it("says how many files and bytes are done, the speed and the ETA", () => {
    const jobs = [
      job("a", { state: "done", size: 1024, bytesDone: 1024 }),
      job("b", { state: "running", size: 3072, bytesDone: 1024 }),
      job("c", { state: "skipped", size: 0 }),
      job("d", { state: "failed", folder: true, size: 0 }),
    ];
    const t = transferTotals(jobs, {});
    expect(t.files).toBe(2);
    expect(t.doneFiles).toBe(1);
    expect(progressText(t, jobs.length, 2048, 42)).toBe(
      "1 of 2 files · 2.0 KB of 4.0 KB · 2.0 KB/s · ~0:42",
    );
    expect(progressText(t, jobs.length, 0, null)).toBe(
      "1 of 2 files · 2.0 KB of 4.0 KB",
    );
    const done = transferTotals([job("a", { state: "done" })], {});
    expect(progressText(done, 1, 0, null)).toBe("1 done");
  });
});
