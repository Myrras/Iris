/**
 * The bottom transfer island: the queue of uploads and downloads.
 *
 * Header: the collapse toggle, a live summary — "Counting… 1,234 files,
 * 56 MB" while a batch counts what it will copy (the total bar then slides
 * indeterminately), else "12 of 340 files · 3.1 MB of 56 MB · 1.5 MB/s ·
 * ~0:42" — Cancel all, Clear finished and Export CSV…, and a total progress bar
 * underneath whose total is fixed once a batch is counted. Body: one row per job (Podium's ProcessRow look), with
 * direction, file name with a muted second line that keeps the local folder
 * on the left and the server's on the right, the arrow pointing the way the
 * bytes move — "Local: /folder → host: /folder" for an upload, "Local:
 * /folder ← host: /folder" for a download (folders only, cut in the middle by
 * `lib/pathEllipsis` to what the column fits; a failed row shows its error
 * there instead; both full paths in the tooltip), progress, bytes, speed, a
 * `StatusDot` + state,
 * a cancel button while it is unfinished and a retry button once it failed.
 * Right-click a row: copy either path, show the local one in the file
 * manager. A folder
 * that could not be listed or made is a placeholder row (folder icon)
 * until retrying lists it into file rows. The list is virtualised, so a folder of
 * thousands of files stays cheap.
 *
 * Data comes from `transferStore` (events + throttled re-pulls); totals are
 * computed from the jobs so they move with every progress event. The
 * collapse state persists via `layoutStore`; a new batch opens the panel.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { TransferJob } from "../ipc/types";
import { exportTransfers } from "../lib/exportTransfers";
import { formatSize } from "../lib/fileFormat";
import { fileManagerName, revealLocalPath } from "../lib/openLocal";
import { baseName, parentPath } from "../lib/path";
import { charsThatFit, ellipsizePath } from "../lib/pathEllipsis";
import {
  countingText,
  formatSpeed,
  isFinal,
  progressText,
  stateLabel,
  stateTone,
  transferTotals,
} from "../lib/transferFormat";
import { useLayoutStore } from "../state/layoutStore";
import { useProfilesStore } from "../state/profilesStore";
import { useSessionStore } from "../state/sessionStore";
import { toastError, toastSuccess } from "../state/toastStore";
import {
  countingBatches,
  orderedJobs,
  useTransferStore,
} from "../state/transferStore";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ProgressBar } from "./ProgressBar";
import { StatusDot } from "./StatusDot";
import {
  CaretIcon,
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  RetryIcon,
  TransfersIcon,
  UploadIcon,
} from "./icons";
import styles from "./TransferPanel.module.css";

/** Two lines: the name and the muted paths (or error) line. */
const ROW_HEIGHT = 40;
/** Characters of path shown before the list has been measured. */
const DEFAULT_PATH_CHARS = 120;
/** The paths line always starts with the local side, like the Local pane. */
const LOCAL_LABEL = "Local";

/** The folder a job's path lives in (a folder placeholder is its own). */
function folderOf(path: string, isFolder: boolean): string {
  return isFolder ? path : (parentPath(path) ?? path);
}

/** "Local" or the connection's host, for the session a job belongs to. */
function useRemoteLabel(sessionId: string): string {
  const profileId = useSessionStore((s) => s.sessions[sessionId]?.profileId);
  const host = useProfilesStore(
    (s) => s.profiles.find((p) => p.id === profileId)?.host,
  );
  return host ?? "Remote";
}

async function copyPath(path: string, what: string) {
  try {
    await navigator.clipboard.writeText(path);
    toastSuccess(`${what} path copied`);
  } catch {
    toastError(`Could not copy the ${what.toLowerCase()} path`);
  }
}

function barTone(job: TransferJob): "active" | "done" | "error" | "muted" {
  if (job.state === "done") return "done";
  if (job.state === "failed") return "error";
  if (job.state === "cancelled" || job.state === "skipped") return "muted";
  return "active";
}

const JobRow = memo(function JobRow({
  job,
  speed,
  pathChars,
  onMenu,
}: {
  job: TransferJob;
  speed: number;
  pathChars: number;
  onMenu: (job: TransferJob, x: number, y: number) => void;
}) {
  const remote = useRemoteLabel(job.sessionId);
  const name = baseName(job.src);
  const final = isFinal(job.state);
  const label = stateLabel(job.state);
  const reason = job.error?.message;
  const Direction = job.direction === "upload" ? UploadIcon : DownloadIcon;
  const fraction =
    job.size > 0 ? job.bytesDone / job.size : job.state === "done" ? 1 : 0;
  const upload = job.direction === "upload";
  // Geography rather than source first: each side sits where its pane does,
  // so only the arrow tells an upload from a download.
  const arrow = upload ? "→" : "←";
  const localPath = upload ? job.src : job.dst;
  const remotePath = upload ? job.dst : job.src;
  const localDir = folderOf(localPath, job.folder);
  const remoteDir = folderOf(remotePath, job.folder);
  // Both sides share the line: what is left after the labels, split in two.
  const overhead = LOCAL_LABEL.length + remote.length + 7; // ": " ×2, the arrow
  const sideChars = Math.max(8, Math.floor((pathChars - overhead) / 2));
  const pathsLine = `${LOCAL_LABEL}: ${ellipsizePath(localDir, sideChars)} ${arrow} ${remote}: ${ellipsizePath(remoteDir, sideChars)}`;
  const fullPaths = `${LOCAL_LABEL}: ${localPath} ${arrow} ${remote}: ${remotePath}`;
  const bytes = job.folder
    ? "folder"
    : job.state === "done" || job.bytesDone === 0
      ? formatSize(job.size)
      : `${formatSize(job.bytesDone)} / ${formatSize(job.size)}`;

  return (
    <div
      className={styles.row}
      role="listitem"
      aria-label={name}
      data-state={job.state}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(job, e.clientX, e.clientY);
      }}
    >
      <Direction
        className={styles.direction}
        aria-label={job.direction === "upload" ? "Upload" : "Download"}
        aria-hidden={false}
        role="img"
      />
      <div className={styles.text} data-paths>
        <span className={styles.name} title={`${job.src} → ${job.dst}`}>
          {job.folder && (
            <FolderIcon
              className={styles.folder}
              aria-label="Folder, not listed yet"
              aria-hidden={false}
              role="img"
            />
          )}
          {name}
        </span>
        {reason && job.state === "failed" ? (
          // The error replaces the paths (still in the tooltip) so a failed
          // row stays two lines tall.
          <span
            className={`${styles.paths} ${styles.error}`}
            title={`${reason}\n${fullPaths}`}
          >
            {reason}
          </span>
        ) : (
          <span className={styles.paths} title={fullPaths}>
            {pathsLine}
          </span>
        )}
      </div>
      <ProgressBar
        fraction={fraction}
        label={`${name} progress`}
        tone={barTone(job)}
      />
      <span className={styles.bytes}>{bytes}</span>
      <span className={styles.speed}>
        {job.state === "running" ? formatSpeed(speed) : ""}
      </span>
      <span className={styles.state} title={reason ?? label}>
        <StatusDot
          tone={stateTone(job.state)}
          label={reason ? `${label}: ${reason}` : label}
          pulse={job.state === "running"}
        />
        <span className={styles.stateText}>{label}</span>
      </span>
      {job.state === "failed" ? (
        <button
          type="button"
          className={styles.action}
          aria-label={`Retry ${name}`}
          title="Retry"
          onClick={() => void useTransferStore.getState().retry(job.id)}
        >
          <RetryIcon size={12} />
        </button>
      ) : final ? (
        <span />
      ) : (
        <button
          type="button"
          className={styles.action}
          aria-label={`Cancel ${name}`}
          title="Cancel"
          onClick={() => void useTransferStore.getState().cancel(job.id)}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
});

function JobList({
  jobs,
  speeds,
}: {
  jobs: TransferJob[];
  speeds: Record<string, number>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pathChars, setPathChars] = useState(DEFAULT_PATH_CHARS);
  const [menu, setMenu] = useState<{
    job: TransferJob;
    x: number;
    y: number;
  } | null>(null);
  const hasJobs = jobs.length > 0;

  // Fit the paths: measure the text column of the first rendered row (all
  // rows share the grid) and convert its width to characters. Re-measured
  // whenever the list resizes. jsdom has no layout (width 0): keep the default.
  useEffect(() => {
    const list = scrollRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const column = list.querySelector<HTMLElement>("[data-paths]");
      const width = column?.clientWidth ?? 0;
      if (width > 0) setPathChars(charsThatFit(width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [hasJobs]);

  const virtualizer = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => jobs[i].id,
  });
  return (
    <div ref={scrollRef} className={styles.list} role="list">
      <div
        className={styles.canvas}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((vr) => {
          const job = jobs[vr.index];
          return (
            <div
              key={job.id}
              className={styles.slot}
              style={{
                transform: `translateY(${vr.start}px)`,
                height: vr.size,
              }}
            >
              <JobRow
                job={job}
                speed={speeds[job.id] ?? 0}
                pathChars={pathChars}
                onMenu={(j, x, y) => setMenu({ job: j, x, y })}
              />
            </div>
          );
        })}
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu ? menuItems(menu.job) : []}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

/** Copy actions for both paths; reveal only for the side that is local. */
function menuItems(job: TransferJob): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: "Copy Source Path",
      onSelect: () => void copyPath(job.src, "Source"),
    },
    {
      label: "Copy Destination Path",
      onSelect: () => void copyPath(job.dst, "Destination"),
    },
  ];
  const upload = job.direction === "upload";
  items.push({
    label: `Show in ${fileManagerName}`,
    onSelect: () => void revealLocalPath(upload ? job.src : job.dst),
    // A download's local copy exists once it has started writing.
    disabled: !upload && job.bytesDone === 0 && job.state !== "done",
  });
  return items;
}

export function TransferPanel() {
  const collapsed = useLayoutStore((s) => s.transfersCollapsed);
  const setCollapsed = useLayoutStore((s) => s.setTransfersCollapsed);
  const jobsById = useTransferStore((s) => s.jobs);
  const order = useTransferStore((s) => s.order);
  const speeds = useTransferStore((s) => s.speeds);
  const batches = useTransferStore((s) => s.batches);
  const coreSummary = useTransferStore((s) => s.summary);

  const jobs = useMemo(
    () => orderedJobs({ jobs: jobsById, order }),
    [jobsById, order],
  );
  const totals = useMemo(() => transferTotals(jobs, speeds), [jobs, speeds]);
  const counting = countingBatches(batches).length > 0;
  const unfinished = jobs.length - totals.finished;
  const busy = unfinished > 0 || counting;
  const counted = countingText(batches);
  const summary = [
    counted,
    progressText(
      totals,
      jobs.length,
      coreSummary.bytesPerSec,
      counting ? null : coreSummary.etaSecs,
    ),
  ]
    .filter(Boolean)
    .join(" · ");
  const store = useTransferStore.getState;

  return (
    <section className={styles.panel} aria-label="Transfers">
      <header className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-controls="transfer-panel-body"
          title={`${collapsed ? "Expand" : "Collapse"} Transfers`}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span
            className={styles.caretWrap}
            data-open={!collapsed ? "true" : undefined}
          >
            <CaretIcon size={12} />
          </span>
          <TransfersIcon className={styles.icon} />
          <span className={styles.title}>Transfers</span>
        </button>
        <span className={styles.summary} aria-live="polite">
          {summary}
        </span>
        <div className={styles.headerActions}>
          {busy && (
            <button
              type="button"
              className={styles.headerAction}
              onClick={() => void store().cancelAll()}
            >
              Cancel all
            </button>
          )}
          {totals.finished > 0 && (
            <button
              type="button"
              className={styles.headerAction}
              onClick={() => void store().clearFinished()}
            >
              Clear finished
            </button>
          )}
          <button
            type="button"
            className={styles.headerAction}
            disabled={jobs.length === 0}
            title="Save the transfer list as a CSV file"
            onClick={() => void exportTransfers()}
          >
            Export CSV…
          </button>
        </div>
      </header>
      {(jobs.length > 0 || counting) && (
        <div className={styles.total}>
          <ProgressBar
            fraction={
              counting
                ? null
                : totals.totalBytes > 0
                  ? totals.doneBytes / totals.totalBytes
                  : unfinished === 0
                    ? 1
                    : 0
            }
            label="Total progress"
            tone={busy ? "active" : "done"}
          />
        </div>
      )}
      <div
        id="transfer-panel-body"
        className={`${styles.body}${collapsed ? ` ${styles.bodyCollapsed}` : ""}`}
        aria-hidden={collapsed}
      >
        <div className={styles.bodyInner}>
          {jobs.length === 0 && counting ? (
            <p className={styles.placeholder}>
              {counted}. The transfer starts once everything is counted.
            </p>
          ) : jobs.length === 0 ? (
            <p className={styles.placeholder}>
              No transfers yet. Drag files between the panes, or use Upload and
              Download.
            </p>
          ) : (
            <JobList jobs={jobs} speeds={speeds} />
          )}
        </div>
      </div>
    </section>
  );
}
