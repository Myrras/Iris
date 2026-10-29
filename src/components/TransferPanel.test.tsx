import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/exportTransfers", () => ({
  exportTransfers: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../lib/openLocal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/openLocal")>()),
  revealLocalPath: vi.fn(() => Promise.resolve(true)),
}));
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
import { exportTransfers } from "../lib/exportTransfers";
import { revealLocalPath } from "../lib/openLocal";
import { summaryText, transferTotals } from "../lib/transferFormat";
import { useLayoutStore } from "../state/layoutStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
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
    startedAt: null,
    finishedAt: null,
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
  useProfilesStore.setState({
    profiles: [
      {
        id: "p-1",
        name: "Web server",
        host: "web.example.test",
        port: 22,
        user: "deploy",
        auth: { kind: "agent" },
        startDir: null,
        jump: null,
        favorites: [],
      },
    ],
  });
  useSessionStore.setState({
    sessions: {
      "s-1": {
        sessionId: "s-1",
        profileId: "p-1",
        state: { status: "connected" },
      },
    },
  });
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

  it("exports the list as CSV, once there is something to export", () => {
    const { unmount } = render(<TransferPanel />);
    expect(screen.getByRole("button", { name: "Export CSV…" })).toBeDisabled();
    unmount();
    setJobs([job("a", { state: "done", bytesDone: 2048 })]);
    render(<TransferPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV…" }));
    expect(exportTransfers).toHaveBeenCalledTimes(1);
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

  describe("paths", () => {
    const writeText = vi.fn(() => Promise.resolve());
    beforeEach(() => {
      writeText.mockClear();
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
    });

    function pathsLine(name: string) {
      const row = screen.getByRole("listitem", { name });
      return row.querySelector<HTMLElement>("[data-paths] > span:last-child")!;
    }

    it("shows the folders for an upload, Local on the left", () => {
      setJobs([
        job("a", {
          src: "/Users/me/project/src/a.txt",
          dst: "/var/www/site/src/a.txt",
        }),
      ]);
      render(<TransferPanel />);
      expect(pathsLine("a.txt")).toHaveTextContent(
        "Local: /Users/me/project/src → web.example.test: /var/www/site/src",
      );
    });

    it("shows the folders for a download, Local still on the left", () => {
      setJobs([
        job("a", {
          direction: "download",
          src: "/var/www/site/a.txt",
          dst: "/Users/me/dl/a.txt",
        }),
      ]);
      render(<TransferPanel />);
      expect(pathsLine("a.txt")).toHaveTextContent(
        "Local: /Users/me/dl ← web.example.test: /var/www/site",
      );
      expect(pathsLine("a.txt")).toHaveAttribute(
        "title",
        "Local: /Users/me/dl/a.txt ← web.example.test: /var/www/site/a.txt",
      );
    });

    it("tells the two directions apart by the arrow alone", () => {
      const local = "/Users/me/site/a.txt";
      const server = "/var/www/site/a.txt";
      setJobs([job("a", { src: local, dst: server })]);
      const { unmount } = render(<TransferPanel />);
      const up = pathsLine("a.txt").textContent ?? "";
      unmount();

      setJobs([job("a", { direction: "download", src: server, dst: local })]);
      render(<TransferPanel />);
      const down = pathsLine("a.txt").textContent ?? "";

      expect(up).toBe(
        "Local: /Users/me/site → web.example.test: /var/www/site",
      );
      expect(down.replace(" ← ", " → ")).toBe(up);
    });

    it("cuts long folders in the middle", () => {
      const deep = "/Users/me/" + "very-long-folder/".repeat(8) + "last";
      setJobs([job("a", { src: `${deep}/a.txt`, dst: "/srv/a.txt" })]);
      render(<TransferPanel />);
      const text = pathsLine("a.txt").textContent ?? "";
      expect(text).toContain("…");
      expect(text).toContain("/Users/me");
      expect(text).toContain("/last");
      // Both labels and the arrow survive the cut: the budget allows for them.
      expect(text.startsWith("Local: /Users/me")).toBe(true);
      expect(text).toContain(" → web.example.test: /srv");
    });

    it("carries both full paths in the tooltip", () => {
      setJobs([job("a", { src: "/Users/me/p/a.txt", dst: "/srv/x/a.txt" })]);
      render(<TransferPanel />);
      expect(pathsLine("a.txt")).toHaveAttribute(
        "title",
        "Local: /Users/me/p/a.txt → web.example.test: /srv/x/a.txt",
      );
    });

    it("copies the source and destination paths", () => {
      setJobs([job("a", { src: "/Users/me/p/a.txt", dst: "/srv/x/a.txt" })]);
      render(<TransferPanel />);
      fireEvent.contextMenu(screen.getByRole("listitem", { name: "a.txt" }));
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Copy Source Path" }),
      );
      expect(writeText).toHaveBeenLastCalledWith("/Users/me/p/a.txt");

      fireEvent.contextMenu(screen.getByRole("listitem", { name: "a.txt" }));
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Copy Destination Path" }),
      );
      expect(writeText).toHaveBeenLastCalledWith("/srv/x/a.txt");
    });

    it("offers reveal only for the local side", () => {
      setJobs([
        job("up", { src: "/Users/me/up.txt", dst: "/srv/up.txt" }),
        job("down", {
          direction: "download",
          src: "/srv/down.txt",
          dst: "/Users/me/down.txt",
          state: "done",
          bytesDone: 2048,
        }),
      ]);
      render(<TransferPanel />);
      fireEvent.contextMenu(screen.getByRole("listitem", { name: "up.txt" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /^Show in / }));
      expect(revealLocalPath).toHaveBeenLastCalledWith("/Users/me/up.txt");

      fireEvent.contextMenu(screen.getByRole("listitem", { name: "down.txt" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /^Show in / }));
      expect(revealLocalPath).toHaveBeenLastCalledWith("/Users/me/down.txt");
      expect(revealLocalPath).not.toHaveBeenCalledWith("/srv/up.txt");
      expect(revealLocalPath).not.toHaveBeenCalledWith("/srv/down.txt");
    });

    it("keeps a failed row's error visible", () => {
      setJobs([
        job("c", {
          state: "failed",
          error: { kind: "permissionDenied", message: "Permission denied" },
        }),
      ]);
      render(<TransferPanel />);
      expect(pathsLine("c.txt")).toHaveTextContent("Permission denied");
      expect(pathsLine("c.txt").title).toContain("/home/alice/c.txt");
    });
  });
});
