import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = vi.hoisted(
  () => ({}) as Record<string, (e: { payload: unknown }) => void>,
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    listeners[name] = cb;
    return Promise.resolve(() => {});
  }),
}));

import {
  onTransferConflict,
  onTransferJobChanged,
  onTransferProgress,
  onTransfersUpdated,
} from "./events";
import type {
  TransferConflictEvent,
  TransferJobChangedEvent,
  TransferProgressEvent,
} from "./types";

describe("transfer events", () => {
  beforeEach(() => {
    for (const name of Object.keys(listeners)) delete listeners[name];
  });

  it("listens under the names src-tauri emits", async () => {
    await onTransfersUpdated(() => {});
    await onTransferJobChanged(() => {});
    await onTransferProgress(() => {});
    await onTransferConflict(() => {});
    expect(Object.keys(listeners).sort()).toEqual([
      "transfer:conflict",
      "transfer:job-changed",
      "transfer:progress",
      "transfers:updated",
    ]);
  });

  it("hands each handler the payload", async () => {
    const progress: TransferProgressEvent = {
      type: "transferProgress",
      jobId: "t-1",
      batchId: "b-1",
      bytesDone: 512,
      size: 1024,
      bytesPerSec: 2048,
    };
    const conflict: TransferConflictEvent = {
      type: "transferConflict",
      batchId: "b-1",
      jobId: "t-1",
      src: { path: "/home/demo/a.txt", size: 10, mtime: 1_700_000_000 },
      dst: { path: "/srv/a.txt", size: 4, mtime: null },
    };
    const changed: TransferJobChangedEvent = {
      type: "transferJobChanged",
      job: {
        id: "t-1",
        batchId: "b-1",
        sessionId: "s-1",
        direction: "upload",
        src: "/home/demo/a.txt",
        dst: "/srv/a.txt",
        size: 10,
        bytesDone: 0,
        state: "needsDecision",
        error: null,
      },
    };
    const onProgress = vi.fn();
    const onConflict = vi.fn();
    const onChanged = vi.fn();
    const onUpdated = vi.fn();
    await onTransferProgress(onProgress);
    await onTransferConflict(onConflict);
    await onTransferJobChanged(onChanged);
    await onTransfersUpdated(onUpdated);
    listeners["transfer:progress"]({ payload: progress });
    listeners["transfer:conflict"]({ payload: conflict });
    listeners["transfer:job-changed"]({ payload: changed });
    listeners["transfers:updated"]({ payload: null });
    expect(onProgress).toHaveBeenCalledWith(progress);
    expect(onConflict).toHaveBeenCalledWith(conflict);
    expect(onChanged).toHaveBeenCalledWith(changed);
    expect(onUpdated).toHaveBeenCalledWith();
  });
});
