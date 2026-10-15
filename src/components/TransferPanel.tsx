/**
 * The bottom transfer island: the queue of uploads and downloads.
 *
 * Header: the collapse toggle, a live summary ("2 active · 5 queued ·
 * 3.1 MB/s · ETA 0:42"), Cancel all and Clear finished, and a total progress
 * bar underneath. Body: one row per job (Podium's ProcessRow look), with
 * direction, file name (full paths in the tooltip), progress, bytes, speed,
 * a `StatusDot` + state (a failure's reason in its tooltip), a cancel
 * button while it is unfinished and a retry button once it failed. A folder
 * whose listing a dropped connection cut off is a placeholder row (folder
 * icon) until resuming or retrying lists it into file rows. The list is virtualised, so a folder of
 * thousands of files stays cheap.
 *
 * Data comes from `transferStore` (events + throttled re-pulls); totals are
 * computed from the jobs so they move with every progress event. The
 * collapse state persists via `layoutStore`; a new batch opens the panel.
 */

import { memo, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { TransferJob } from "../ipc/types";
import { formatSize } from "../lib/fileFormat";
import { baseName } from "../lib/path";
import {
  formatSpeed,
  isFinal,
  stateLabel,
  stateTone,
  summaryText,
  transferTotals,
} from "../lib/transferFormat";
import { useLayoutStore } from "../state/layoutStore";
import { orderedJobs, useTransferStore } from "../state/transferStore";
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

const ROW_HEIGHT = 28;

function barTone(job: TransferJob): "active" | "done" | "error" | "muted" {
  if (job.state === "done") return "done";
  if (job.state === "failed") return "error";
  if (job.state === "cancelled" || job.state === "skipped") return "muted";
  return "active";
}

const JobRow = memo(function JobRow({
  job,
  speed,
}: {
  job: TransferJob;
  speed: number;
}) {
  const name = baseName(job.src);
  const final = isFinal(job.state);
  const label = stateLabel(job.state);
  const reason = job.error?.message;
  const Direction = job.direction === "upload" ? UploadIcon : DownloadIcon;
  const fraction =
    job.size > 0 ? job.bytesDone / job.size : job.state === "done" ? 1 : 0;
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
    >
      <Direction
        className={styles.direction}
        aria-label={job.direction === "upload" ? "Upload" : "Download"}
        aria-hidden={false}
        role="img"
      />
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
              <JobRow job={job} speed={speeds[job.id] ?? 0} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TransferPanel() {
  const collapsed = useLayoutStore((s) => s.transfersCollapsed);
  const setCollapsed = useLayoutStore((s) => s.setTransfersCollapsed);
  const jobsById = useTransferStore((s) => s.jobs);
  const order = useTransferStore((s) => s.order);
  const speeds = useTransferStore((s) => s.speeds);

  const jobs = useMemo(
    () => orderedJobs({ jobs: jobsById, order }),
    [jobsById, order],
  );
  const totals = useMemo(() => transferTotals(jobs, speeds), [jobs, speeds]);
  const unfinished = jobs.length - totals.finished;
  const summary = summaryText(totals, jobs.length);
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
          {unfinished > 0 && (
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
        </div>
      </header>
      {jobs.length > 0 && (
        <div className={styles.total}>
          <ProgressBar
            fraction={
              totals.totalBytes > 0
                ? totals.doneBytes / totals.totalBytes
                : unfinished === 0
                  ? 1
                  : 0
            }
            label="Total progress"
            tone={unfinished === 0 ? "done" : "active"}
          />
        </div>
      )}
      <div
        id="transfer-panel-body"
        className={`${styles.body}${collapsed ? ` ${styles.bodyCollapsed}` : ""}`}
        aria-hidden={collapsed}
      >
        <div className={styles.bodyInner}>
          {jobs.length === 0 ? (
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
