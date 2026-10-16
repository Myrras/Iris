/**
 * One-way sync between the active tab's Local and Remote folders, opened by
 * `syncStore` (pane toolbar, context menu, ⌥⌘S / Ctrl+Alt+S).
 *
 * Set up the direction (Local → Remote or Remote → Local, both full paths
 * shown), the mode (Update, or Mirror with a warning), the compare rule
 * and the options (remembered in `settingsStore.sync`), then Compare: the
 * core walks both folders (`planSync`) and the plan shows grouped — New,
 * Changed, Newer on target, Different size same date, Will be deleted /
 * Only on target, Skipped — with counts and bytes, collapsible
 * (virtualised) lists and a tick per item. Changing any choice after a
 * comparison compares again. Sync runs the ticked items (`runSync`); with
 * deletes, Mirror asks once more in the dialog (DeleteConfirmModal's
 * words). Progress shows in the transfer panel; `sync:finished` toasts and
 * re-lists the panes (`syncStore.syncFinished`).
 *
 * Looks: the Modal with ConflictDialog's facts block and Prompts toggles.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import {
  discardSyncPlan,
  planSync,
  runSync,
  toIpcError,
} from "../ipc/commands";
import { onSyncProgress } from "../ipc/events";
import type {
  CompareRule,
  SyncItem,
  SyncMode,
  SyncPlan,
  TransferDirection,
} from "../ipc/types";
import { formatModifiedFull } from "../lib/dateFormat";
import { formatSize } from "../lib/fileFormat";
import {
  defaultTicks,
  deleteNames,
  effectiveSkipHidden,
  isActionable,
  planOptions,
  runCounts,
  scanText,
  SECTIONS,
  sectionCount,
  sectionItems,
  sectionLabel,
  sectionTicked,
  setSectionTicks,
  setTick,
  sides,
  tickedPaths,
  type SyncSection,
} from "../lib/sync";
import { remoteSessionId } from "../lib/transfer";
import { useLayoutStore } from "../state/layoutStore";
import { itemCount, TRASH_NAME, usePaneStore } from "../state/paneStore";
import {
  SYNC_MAX_SIZE_MAX_MB,
  SYNC_MAX_SIZE_MIN_MB,
  useSettingsStore,
} from "../state/settingsStore";
import { useSyncStore, type SyncRequest } from "../state/syncStore";
import { useTransferStore } from "../state/transferStore";
import { CaretIcon } from "./icons";
import { Modal } from "./Modal";
import prompts from "./Prompts.module.css";
import styles from "./SyncDialog.module.css";

/** One row of an item list, in px (the virtualiser's estimate too). */
const ROW_HEIGHT = 26;
/** How many names the delete confirm lists before "and N more". */
const SHOWN_NAMES = 5;

const RULES: [CompareRule, string, string][] = [
  [
    "sizeOrDate",
    "Size or date differs",
    "Copy when the size differs or the dates are more than 2 seconds apart.",
  ],
  ["newerOnly", "Newer only", "Copy only files that are newer on the source."],
  [
    "sizeOnly",
    "Size only",
    "Copy when the size differs; dates are ignored (for servers that do not keep them).",
  ],
  [
    "everything",
    "Everything",
    "Copy every file, also the ones that look the same.",
  ],
];

type Phase = "setup" | "comparing" | "review" | "confirm" | "starting";

export function SyncDialog() {
  const request = useSyncStore((s) => s.request);
  // Keep the last request on screen while the dialog animates closed.
  const [shown, setShown] = useState<SyncRequest | null>(request);
  const [direction, setDirection] = useState<TransferDirection>(
    request?.direction ?? "upload",
  );
  const [mode, setMode] = useState<SyncMode>("update");
  const [phase, setPhase] = useState<Phase>("setup");
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [ticks, setTicks] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<SyncSection>>(new Set());
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (request && request.id !== shown?.id) {
    setShown(request);
    setDirection(request.direction);
    setMode("update");
    setPhase("setup");
    setPlan(null);
    setTicks(new Set());
    setExpanded(new Set());
    setError(null);
  }

  const prefs = useSettingsStore((s) => s.sync);
  const setSettings = useSettingsStore((s) => s.set);
  const sourcePane = direction === "upload" ? "local" : "remote";
  const paneHidden = usePaneStore((s) => s.panes[sourcePane].showHidden);
  const globalHidden = useSettingsStore((s) => s.browser.showHidden);
  const showHidden = paneHidden ?? globalHidden;
  const localDir = usePaneStore((s) => s.panes.local.path);
  const remoteDir = usePaneStore((s) => s.panes.remote.path);

  // The newest compare; an older answer is thrown away on arrival.
  const token = useRef(0);
  // The running comparison's plan id, to pick its progress events.
  const scanId = useRef<string | null>(null);
  const [scan, setScan] = useState<{ folders: number; files: number } | null>(
    null,
  );
  const compared = useRef(false);
  const planRef = useRef<SyncPlan | null>(null);
  planRef.current = plan;

  const optionsKey = JSON.stringify(planOptions(mode, prefs, showHidden));
  const compare = useCallback(async () => {
    const sessionId = remoteSessionId();
    if (!sessionId || !localDir || !remoteDir) {
      setError("Connect and open a folder in both panes to sync.");
      return;
    }
    const mine = ++token.current;
    compared.current = true;
    const old = planRef.current;
    if (old) void discardSyncPlan(old.planId).catch(() => undefined);
    setPlan(null);
    setPhase("comparing");
    setError(null);
    const planId = crypto.randomUUID();
    scanId.current = planId;
    setScan(null);
    try {
      const next = await planSync(
        sessionId,
        direction,
        localDir,
        remoteDir,
        JSON.parse(optionsKey),
        planId,
      );
      if (mine !== token.current) {
        void discardSyncPlan(next.planId).catch(() => undefined);
        return;
      }
      setPlan(next);
      setTicks(defaultTicks(next));
      setPhase("review");
    } catch (e) {
      if (mine !== token.current) return;
      setError(toIpcError(e).message);
      setPhase("setup");
    }
  }, [direction, localDir, remoteDir, optionsKey]);

  // Walk progress while comparing ("Scanning… 812 folders, 5,120 files").
  useEffect(() => {
    if (phase !== "comparing") return;
    let unlisten: (() => void) | undefined;
    let gone = false;
    onSyncProgress((e) => {
      if (e.planId === scanId.current) {
        setScan({ folders: e.foldersScanned, files: e.filesSeen });
      }
    })
      .then((u) => {
        if (gone) u();
        else unlisten = u;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [phase]);

  // A changed choice after a comparison compares again.
  useEffect(() => {
    if (compared.current) void compare();
  }, [compare]);

  const close = useCallback(() => {
    token.current += 1;
    compared.current = false;
    const old = planRef.current;
    if (old) void discardSyncPlan(old.planId).catch(() => undefined);
    setPlan(null);
    useSyncStore.getState().close();
  }, []);

  const start = async () => {
    if (!plan) return;
    const counts = runCounts(plan, ticks);
    if (plan.mode === "mirror" && counts.deletes > 0 && phase !== "confirm") {
      setPhase("confirm");
      return;
    }
    setPhase("starting");
    setError(null);
    try {
      await runSync(plan.planId, tickedPaths(plan, ticks));
    } catch (e) {
      const err = toIpcError(e);
      setError(err.message);
      if (err.kind === "notFound") {
        // Expired or dropped: only a new comparison helps.
        setPlan(null);
        setPhase("setup");
      } else {
        setPhase("review");
      }
      return;
    }
    // Ran: nothing left to discard.
    planRef.current = null;
    setPlan(null);
    useLayoutStore.getState().setTransfersCollapsed(false);
    useTransferStore.getState().scheduleResync();
    close();
  };

  if (!shown) return null;
  const { source, target } = sides(direction);
  const srcPath = direction === "upload" ? localDir : remoteDir;
  const dstPath = direction === "upload" ? remoteDir : localDir;
  const busy = phase === "comparing" || phase === "starting";
  const counts = plan ? runCounts(plan, ticks) : null;
  const nothing =
    !counts || counts.copies + counts.folders + counts.deletes === 0;
  const remoteTarget = direction === "upload";
  const deleting = plan && phase === "confirm" ? deleteNames(plan, ticks) : [];

  const footer =
    phase === "confirm" && plan ? (
      <>
        <button type="button" onClick={() => setPhase("review")}>
          Back
        </button>
        <button type="button" className="danger" onClick={() => void start()}>
          {remoteTarget
            ? "Sync and delete permanently"
            : `Sync and move to ${TRASH_NAME}`}
        </button>
      </>
    ) : (
      <>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className={plan ? undefined : "primary"}
          disabled={busy}
          onClick={() => void compare()}
        >
          {plan ? "Compare again" : "Compare"}
        </button>
        {plan && (
          <button
            type="button"
            className="primary"
            disabled={busy || nothing}
            onClick={() => void start()}
          >
            {syncLabel(counts)}
          </button>
        )}
      </>
    );

  return (
    <Modal
      open={request !== null}
      title={
        phase === "confirm"
          ? remoteTarget
            ? `Delete ${itemCount(deleting.length)}?`
            : `Move ${itemCount(deleting.length)} to the ${TRASH_NAME}?`
          : "Sync folders"
      }
      tone={
        phase === "confirm" ? (remoteTarget ? "danger" : "warning") : "default"
      }
      onClose={close}
      width={640}
      footer={footer}
    >
      {phase === "confirm" && plan ? (
        <DeleteConfirm
          names={deleting}
          direction={plan.direction}
          remote={remoteTarget}
        />
      ) : (
        <div className={styles.body}>
          <div
            className={styles.segmented}
            role="radiogroup"
            aria-label="Direction"
          >
            {(["upload", "download"] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                className={styles.segment}
                data-active={direction === d ? "true" : undefined}
                disabled={busy}
                onClick={() => setDirection(d)}
              >
                {d === "upload" ? "Local → Remote" : "Remote → Local"}
              </button>
            ))}
          </div>
          <dl className={styles.paths}>
            <dt>From {source}</dt>
            <dd className={prompts.mono} title={srcPath ?? undefined}>
              {srcPath ?? "No folder open"}
            </dd>
            <dt>To {target}</dt>
            <dd className={prompts.mono} title={dstPath ?? undefined}>
              {dstPath ?? "No folder open"}
            </dd>
          </dl>

          <div className={styles.controls}>
            <div
              className={styles.segmented}
              role="radiogroup"
              aria-label="Mode"
            >
              {(["update", "mirror"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  className={styles.segment}
                  data-active={mode === m ? "true" : undefined}
                  disabled={busy}
                  onClick={() => setMode(m)}
                >
                  {m === "update" ? "Update" : "Mirror"}
                </button>
              ))}
            </div>
            <label className={styles.rule}>
              <span>Copy when</span>
              <select
                value={prefs.rule}
                disabled={busy}
                onChange={(e) =>
                  setSettings("sync", { rule: e.target.value as CompareRule })
                }
              >
                {RULES.map(([rule, label]) => (
                  <option key={rule} value={rule}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className={styles.hint}>
            {RULES.find(([r]) => r === prefs.rule)?.[2]}
            {mode === "update" && " Update never deletes anything."}
          </p>
          {mode === "mirror" && (
            <p className={prompts.notice} role="note">
              <strong>Mirror</strong> also deletes files and folders that exist
              only on {target}
              {remoteTarget
                ? " — permanently, from the server."
                : ` — they go to the ${TRASH_NAME}.`}{" "}
              Nothing is deleted when a copy fails.
            </p>
          )}

          <SyncOptionsPanel
            open={optionsOpen}
            onToggle={() => setOptionsOpen((o) => !o)}
            showHidden={showHidden}
            disabled={busy}
          />

          {error && (
            <p className={prompts.error} role="alert">
              {error}
            </p>
          )}
          {phase === "comparing" && (
            <p className={styles.status} role="status">
              <span className="spinner" aria-hidden />{" "}
              {scan
                ? scanText(scan.folders, scan.files)
                : `Comparing ${source} and ${target}…`}
            </p>
          )}
          {phase === "starting" && (
            <p className={styles.status} role="status">
              <span className="spinner" aria-hidden /> Starting…
            </p>
          )}
          {plan && (
            <Review
              plan={plan}
              ticks={ticks}
              onTicks={setTicks}
              expanded={expanded}
              onExpanded={setExpanded}
              everything={prefs.rule === "everything"}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

function syncLabel(
  counts: { copies: number; folders: number; deletes: number } | null,
): string {
  if (!counts) return "Sync";
  const parts: string[] = [];
  if (counts.copies > 0) parts.push(`copy ${counts.copies}`);
  if (counts.deletes > 0) parts.push(`delete ${counts.deletes}`);
  return parts.length > 0 ? `Sync (${parts.join(", ")})` : "Sync";
}

/** The disclosure with the remembered options. */
function SyncOptionsPanel({
  open,
  onToggle,
  showHidden,
  disabled,
}: {
  open: boolean;
  onToggle: () => void;
  showHidden: boolean;
  disabled: boolean;
}) {
  const prefs = useSettingsStore((s) => s.sync);
  const set = (patch: Partial<typeof prefs>) =>
    useSettingsStore.getState().set("sync", patch);
  const implied = prefs.rule === "newerOnly";
  return (
    <div className={styles.options}>
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={styles.caret} data-open={open ? "true" : undefined}>
          <CaretIcon />
        </span>
        Options
      </button>
      {open && (
        <div className={styles.optionList}>
          <label className={prompts.toggle}>
            <input
              type="checkbox"
              checked={implied || prefs.protectNewer}
              disabled={disabled || implied}
              onChange={(e) => set({ protectNewer: e.target.checked })}
            />
            <span>
              Don&apos;t overwrite files that are newer on the target
              {implied && <small>Always so with “Newer only”.</small>}
            </span>
          </label>
          <label className={prompts.toggle}>
            <input
              type="checkbox"
              checked={effectiveSkipHidden(prefs, showHidden)}
              disabled={disabled}
              onChange={(e) => set({ skipHidden: e.target.checked })}
            />
            <span>
              Skip hidden files
              <small>Dotfiles on both sides are never copied or deleted.</small>
            </span>
          </label>
          <label className={prompts.toggle}>
            <input
              type="checkbox"
              checked={prefs.copyEmptyFolders}
              disabled={disabled}
              onChange={(e) => set({ copyEmptyFolders: e.target.checked })}
            />
            <span>Copy empty folders</span>
          </label>
          <div className={styles.sizeRow}>
            <label className={prompts.toggle}>
              <input
                type="checkbox"
                checked={prefs.limitSize}
                disabled={disabled}
                onChange={(e) => set({ limitSize: e.target.checked })}
              />
              <span>Skip files larger than</span>
            </label>
            {prefs.limitSize && (
              <label className={styles.sizeField}>
                <input
                  type="number"
                  min={SYNC_MAX_SIZE_MIN_MB}
                  max={SYNC_MAX_SIZE_MAX_MB}
                  value={prefs.maxSizeMb}
                  disabled={disabled}
                  aria-label="Size limit in MB"
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    if (
                      Number.isFinite(n) &&
                      n >= SYNC_MAX_SIZE_MIN_MB &&
                      n <= SYNC_MAX_SIZE_MAX_MB
                    ) {
                      set({ maxSizeMb: n });
                    }
                  }}
                />
                <span>MB</span>
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The plan, grouped. */
function Review({
  plan,
  ticks,
  onTicks,
  expanded,
  onExpanded,
  everything,
}: {
  plan: SyncPlan;
  ticks: Set<string>;
  onTicks: (ticks: Set<string>) => void;
  expanded: Set<SyncSection>;
  onExpanded: (expanded: Set<SyncSection>) => void;
  everything: boolean;
}) {
  const shown = SECTIONS.filter(
    (s) =>
      sectionItems(plan, s).length > 0 ||
      (s === "skipped" && plan.totals.same.files > 0),
  );
  const toggle = (section: SyncSection) => {
    const next = new Set(expanded);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    onExpanded(next);
  };
  if (shown.length === 0) {
    return <p className={styles.status}>The folders are empty.</p>;
  }
  return (
    <div className={styles.review} aria-label="Comparison">
      {shown.map((section) => {
        const items = sectionItems(plan, section);
        const label = sectionLabel(
          section,
          plan.mode,
          plan.direction,
          everything,
        );
        const { ticked, total } = sectionTicked(ticks, plan, section);
        const open = expanded.has(section);
        return (
          <section
            key={section}
            className={styles.group}
            data-section={section}
          >
            <div className={styles.groupHeader}>
              {total > 0 ? (
                <input
                  type="checkbox"
                  aria-label={`All of ${label}`}
                  checked={ticked === total}
                  ref={(el) => {
                    if (el) el.indeterminate = ticked > 0 && ticked < total;
                  }}
                  onChange={(e) =>
                    onTicks(
                      setSectionTicks(ticks, plan, section, e.target.checked),
                    )
                  }
                />
              ) : (
                <span className={styles.checkSpace} />
              )}
              <button
                type="button"
                className={styles.groupToggle}
                aria-expanded={open}
                disabled={items.length === 0}
                onClick={() => toggle(section)}
              >
                <span
                  className={styles.caret}
                  data-open={open ? "true" : undefined}
                >
                  <CaretIcon />
                </span>
                <span className={styles.groupLabel}>{label}</span>
                <span className={styles.groupCount}>
                  {section === "skipped"
                    ? skippedCount(plan)
                    : sectionCount(plan, section)}
                </span>
              </button>
            </div>
            {open && items.length > 0 && (
              <ItemList
                items={items}
                plan={plan}
                ticks={ticks}
                onTick={(item, on) => onTicks(setTick(ticks, plan, item, on))}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

/** "12 identical, 2 excluded, 1 not supported". */
function skippedCount(plan: SyncPlan): string {
  const t = plan.totals;
  const n = (g: keyof typeof t) => t[g].files + t[g].dirs;
  const parts: string[] = [];
  if (t.same.files > 0) parts.push(`${t.same.files} identical`);
  if (n("excluded") > 0) parts.push(`${n("excluded")} excluded`);
  if (n("typeMismatch") > 0)
    parts.push(`${n("typeMismatch")} file/folder clash`);
  if (n("skipped") > 0) parts.push(`${n("skipped")} not copied`);
  return parts.join(", ");
}

/** A group's items, virtualised (a big tree can list thousands). */
function ItemList({
  items,
  plan,
  ticks,
  onTick,
}: {
  items: SyncItem[];
  plan: SyncPlan;
  ticks: Set<string>;
  onTick: (item: SyncItem, on: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => items[i].path,
  });
  return (
    <div
      ref={scrollRef}
      className={styles.list}
      role="list"
      style={{
        height: `min(${items.length * ROW_HEIGHT}px, var(--sync-list-h))`,
      }}
    >
      <div
        className={styles.canvas}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index];
          const actionable = isActionable(item.group, plan.mode);
          return (
            <div
              key={row.key}
              role="listitem"
              className={styles.row}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {actionable ? (
                <input
                  type="checkbox"
                  aria-label={item.path}
                  checked={ticks.has(item.path)}
                  onChange={(e) => onTick(item, e.target.checked)}
                />
              ) : (
                <span className={styles.checkSpace} />
              )}
              <span className={styles.path} title={item.path}>
                {item.kind === "dir" ? `${item.path}/` : item.path}
              </span>
              <span className={styles.detail} title={detailTitle(item)}>
                {detail(item)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Sizes (source → target), or why it is left alone. */
function detail(item: SyncItem): string {
  if (item.reason) return item.reason;
  if (item.kind === "dir") return "folder";
  const src = item.srcSize !== null ? formatSize(item.srcSize) : null;
  const dst = item.dstSize !== null ? formatSize(item.dstSize) : null;
  if (src && dst) return `${src} → ${dst}`;
  return src ?? dst ?? "";
}

function detailTitle(item: SyncItem): string | undefined {
  const parts: string[] = [];
  if (item.srcMtime !== null)
    parts.push(`Source: ${formatModifiedFull(item.srcMtime)}`);
  if (item.dstMtime !== null)
    parts.push(`Target: ${formatModifiedFull(item.dstMtime)}`);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** The second confirm of a Mirror run with deletes. */
function DeleteConfirm({
  names,
  direction,
  remote,
}: {
  names: string[];
  direction: TransferDirection;
  remote: boolean;
}) {
  const rest = names.length - SHOWN_NAMES;
  const { target } = sides(direction);
  return (
    <div className={styles.body}>
      <p className={styles.lead}>
        {remote ? (
          <>
            After the copies, these items are deleted from the server{" "}
            <strong>permanently</strong>, folders with everything in them. This
            cannot be undone.
          </>
        ) : (
          <>
            After the copies, these items are moved to the{" "}
            <strong>{TRASH_NAME}</strong>, where you can restore them.
          </>
        )}{" "}
        They exist only on {target}. Nothing is deleted if a copy fails, and an
        item that changed since the comparison is kept.
      </p>
      <ul className={styles.names}>
        {names.slice(0, SHOWN_NAMES).map((name) => (
          <li key={name}>{name}</li>
        ))}
        {rest > 0 && <li className={styles.more}>and {rest} more</li>}
      </ul>
    </div>
  );
}
