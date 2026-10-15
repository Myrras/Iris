import { describe, expect, it } from "vitest";

import type { TransferJob } from "../ipc/types";
import {
  etaSeconds,
  formatEta,
  formatSpeed,
  isFinal,
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
