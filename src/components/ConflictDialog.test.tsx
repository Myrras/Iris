import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  resolveConflict: vi.fn(() => Promise.resolve()),
}));
vi.mock("../state/toastStore", () => ({ toastError: vi.fn() }));

import { resolveConflict } from "../ipc/commands";
import type { TransferConflictEvent } from "../ipc/types";
import { usePromptStore } from "../state/promptStore";
import { toastError } from "../state/toastStore";
import { useTransferStore } from "../state/transferStore";
import { PromptHost } from "./PromptHost";

function conflict(
  jobId: string,
  batchId = "b-1",
  dstSize = 40,
): TransferConflictEvent {
  return {
    type: "transferConflict",
    batchId,
    jobId,
    src: { path: `/home/alice/${jobId}.txt`, size: 100, mtime: 1_700_000_100 },
    dst: { path: `/srv/www/${jobId}.txt`, size: dstSize, mtime: 1_700_000_000 },
  };
}

function push(event: TransferConflictEvent) {
  usePromptStore.getState().push({ kind: "transferConflict", event });
}

beforeEach(() => {
  vi.clearAllMocks();
  usePromptStore.setState({ queue: [] });
  useTransferStore.setState({ jobs: {}, order: [], speeds: {} });
});

describe("ConflictDialog", () => {
  it("compares both sides and names the folder", () => {
    useTransferStore.setState({
      jobs: {
        a: {
          id: "a",
          batchId: "b-1",
          sessionId: "s-1",
          direction: "upload",
          src: "/home/alice/a.txt",
          dst: "/srv/www/a.txt",
          size: 100,
          bytesDone: 0,
          state: "needsDecision",
          error: null,
          folder: false,
          startedAt: null,
          finishedAt: null,
        },
      },
      order: ["a"],
    });
    push(conflict("a"));
    render(<PromptHost />);

    const dialog = screen.getByRole("dialog", { name: "File already exists" });
    expect(dialog).toHaveTextContent("a.txt already exists in /srv/www.");
    expect(dialog).toHaveTextContent("Local");
    expect(dialog).toHaveTextContent("100 B");
    expect(dialog).toHaveTextContent("Remote");
    expect(dialog).toHaveTextContent("40 B");
    expect(dialog).toHaveTextContent("newer");
  });

  it("answers and moves on to the next conflict", async () => {
    push(conflict("a"));
    push(conflict("b"));
    render(<PromptHost />);

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(resolveConflict).toHaveBeenCalledWith("a", "replace", false),
    );
    await waitFor(() =>
      expect(usePromptStore.getState().queue).toHaveLength(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep Both" }));
    await waitFor(() =>
      expect(resolveConflict).toHaveBeenCalledWith("b", "keepBoth", false),
    );
  });

  it("applies to all: drops the batch's other queued conflicts", async () => {
    push(conflict("a"));
    push(conflict("b"));
    push(conflict("c", "b-2"));
    render(<PromptHost />);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Apply to all remaining conflicts in this transfer",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(resolveConflict).toHaveBeenCalledWith("a", "skip", true),
    );
    await waitFor(() =>
      expect(
        usePromptStore
          .getState()
          .queue.map((p) => p.kind === "transferConflict" && p.event.jobId),
      ).toEqual(["c"]),
    );
  });

  it("enables Resume only for a shorter destination", () => {
    push(conflict("a", "b-1", 100));
    const { unmount } = render(<PromptHost />);
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    unmount();

    usePromptStore.setState({ queue: [] });
    push(conflict("b", "b-1", 40));
    render(<PromptHost />);
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
  });

  it("closing skips, and a failed answer is reported", async () => {
    vi.mocked(resolveConflict).mockRejectedValueOnce({
      kind: "invalidInput",
      message: "not waiting for a decision",
    });
    push(conflict("a"));
    render(<PromptHost />);

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() =>
      expect(resolveConflict).toHaveBeenCalledWith("a", "skip", false),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not answer the conflict",
        "not waiting for a decision",
      ),
    );
    expect(usePromptStore.getState().queue).toHaveLength(0);
  });
});
