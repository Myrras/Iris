/**
 * Pure rules of the Sync dialog: which groups it shows and how, which items
 * can be ticked, what a folder tick means, the options sent to `planSync`
 * from the remembered prefs, and the text of the `sync:finished` toast.
 *
 * Ticks are a set of item paths. Unticking a folder unticks everything
 * under it (and ticking it ticks them), so what `runSync` gets is always
 * the explicit list of ticked paths.
 */

import type {
  SyncFinishedEvent,
  SyncGroup,
  SyncItem,
  SyncMode,
  SyncOptions,
  SyncPlan,
  TransferDirection,
} from "../ipc/types";
import type { Settings } from "../state/settingsStore";
import { formatSize } from "./fileFormat";

/** The sections of the review, in order. */
export type SyncSection =
  | "new"
  | "changed"
  | "targetNewer"
  | "differentSizeSameDate"
  | "targetOnly"
  | "skipped";

export const SECTIONS: SyncSection[] = [
  "new",
  "changed",
  "targetNewer",
  "differentSizeSameDate",
  "targetOnly",
  "skipped",
];

/** The groups shown under "Skipped" (with `same` as a count). */
const SKIPPED_GROUPS: SyncGroup[] = ["typeMismatch", "excluded", "skipped"];

/** The groups a section lists. */
export function sectionGroups(section: SyncSection): SyncGroup[] {
  return section === "skipped" ? SKIPPED_GROUPS : [section];
}

/** Whether an item of `group` does anything when ticked. */
export function isActionable(group: SyncGroup, mode: SyncMode): boolean {
  switch (group) {
    case "new":
    case "changed":
    case "targetNewer":
    case "differentSizeSameDate":
      return true;
    case "targetOnly":
      return mode === "mirror";
    default:
      return false;
  }
}

/** "Local" / "Remote" for the source and target of a direction. */
export function sides(direction: TransferDirection): {
  source: string;
  target: string;
} {
  return direction === "upload"
    ? { source: "Local", target: "Remote" }
    : { source: "Remote", target: "Local" };
}

/** A section's heading. */
export function sectionLabel(
  section: SyncSection,
  mode: SyncMode,
  direction: TransferDirection,
  everything = false,
): string {
  const { target } = sides(direction);
  switch (section) {
    case "new":
      return "New";
    case "changed":
      return everything ? "Overwritten" : "Changed";
    case "targetNewer":
      return `Newer on ${target}`;
    case "differentSizeSameDate":
      return "Different size, same date";
    case "targetOnly":
      return mode === "mirror" ? "Will be deleted" : `Only on ${target} (kept)`;
    case "skipped":
      return "Skipped";
  }
}

/** The items of one section, in plan order. */
export function sectionItems(plan: SyncPlan, section: SyncSection): SyncItem[] {
  const groups = sectionGroups(section);
  return plan.items.filter((i) => groups.includes(i.group));
}

/** "3 files, 1 folder · 12 KB" for a list of totals. */
export function countText(files: number, dirs: number, bytes: number): string {
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
  if (dirs > 0) parts.push(`${dirs} ${dirs === 1 ? "folder" : "folders"}`);
  if (parts.length === 0) return "nothing";
  return bytes > 0
    ? `${parts.join(", ")} · ${formatSize(bytes)}`
    : parts.join(", ");
}

/** "Scanning… 812 folders, 5,120 files" while a comparison walks. */
export function scanText(folders: number, files: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `Scanning… ${n(folders)} ${folders === 1 ? "folder" : "folders"}, ${n(files)} ${files === 1 ? "file" : "files"}`;
}

/** The totals text of a section (the plan's totals, summed per group). */
export function sectionCount(plan: SyncPlan, section: SyncSection): string {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  for (const group of sectionGroups(section)) {
    const t = plan.totals[group];
    files += t.files;
    dirs += t.dirs;
    bytes += t.bytes;
  }
  return countText(files, dirs, bytes);
}

/** The paths ticked by default. */
export function defaultTicks(plan: SyncPlan): Set<string> {
  return new Set(
    plan.items
      .filter((i) => i.selected && isActionable(i.group, plan.mode))
      .map((i) => i.path),
  );
}

/** `path` is `dir` or inside it. */
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Tick (`on`) or untick `item`; a folder takes the actionable items of its
 * section inside it along.
 */
export function setTick(
  ticks: Set<string>,
  plan: SyncPlan,
  item: SyncItem,
  on: boolean,
): Set<string> {
  const next = new Set(ticks);
  const affected =
    item.kind === "dir"
      ? plan.items.filter(
          (i) =>
            i.group === item.group &&
            within(i.path, item.path) &&
            isActionable(i.group, plan.mode),
        )
      : [item];
  for (const i of affected) {
    if (on) next.add(i.path);
    else next.delete(i.path);
  }
  return next;
}

/** Tick or untick every actionable item of a section. */
export function setSectionTicks(
  ticks: Set<string>,
  plan: SyncPlan,
  section: SyncSection,
  on: boolean,
): Set<string> {
  const next = new Set(ticks);
  for (const i of sectionItems(plan, section)) {
    if (!isActionable(i.group, plan.mode)) continue;
    if (on) next.add(i.path);
    else next.delete(i.path);
  }
  return next;
}

/** How many of a section's actionable items are ticked, of how many. */
export function sectionTicked(
  ticks: Set<string>,
  plan: SyncPlan,
  section: SyncSection,
): { ticked: number; total: number } {
  let ticked = 0;
  let total = 0;
  for (const i of sectionItems(plan, section)) {
    if (!isActionable(i.group, plan.mode)) continue;
    total += 1;
    if (ticks.has(i.path)) ticked += 1;
  }
  return { ticked, total };
}

/** The ticked actionable paths, in plan order (what `runSync` gets). */
export function tickedPaths(plan: SyncPlan, ticks: Set<string>): string[] {
  return plan.items
    .filter((i) => ticks.has(i.path) && isActionable(i.group, plan.mode))
    .map((i) => i.path);
}

/** What a run would do: files to copy, folders to make, items to delete. */
export function runCounts(
  plan: SyncPlan,
  ticks: Set<string>,
): { copies: number; folders: number; deletes: number } {
  let copies = 0;
  let folders = 0;
  let deletes = 0;
  for (const i of plan.items) {
    if (!ticks.has(i.path) || !isActionable(i.group, plan.mode)) continue;
    if (i.group === "targetOnly") deletes += 1;
    else if (i.kind === "dir") folders += 1;
    else copies += 1;
  }
  return { copies, folders, deletes };
}

/** The top-most ticked target-only items (what the delete confirm names). */
export function deleteNames(plan: SyncPlan, ticks: Set<string>): string[] {
  const picked = plan.items.filter(
    (i) => i.group === "targetOnly" && ticks.has(i.path),
  );
  return picked
    .filter(
      (i) =>
        !picked.some(
          (o) => o !== i && o.kind === "dir" && within(i.path, o.path),
        ),
    )
    .map((i) => (i.kind === "dir" ? `${i.path}/` : i.path));
}

/**
 * The options for `planSync` from the remembered prefs; `showHidden` is
 * the panes' setting, which "skip hidden" follows until it is changed.
 */
export function planOptions(
  mode: SyncMode,
  prefs: Settings["sync"],
  showHidden: boolean,
): SyncOptions {
  return {
    mode,
    rule: prefs.rule,
    protectNewer: prefs.protectNewer,
    skipHidden: effectiveSkipHidden(prefs, showHidden),
    copyEmptyFolders: prefs.copyEmptyFolders,
    maxFileSizeMb: prefs.limitSize ? prefs.maxSizeMb : null,
  };
}

/** "Skip hidden files", resolved against the panes' setting. */
export function effectiveSkipHidden(
  prefs: Settings["sync"],
  showHidden: boolean,
): boolean {
  return prefs.skipHidden ?? !showHidden;
}

/** The toast for a finished run: `[kind, title, detail]`. */
export function finishedToast(
  event: SyncFinishedEvent,
): ["success" | "error", string, string | undefined] {
  const parts: string[] = [];
  parts.push(`${event.copied} ${event.copied === 1 ? "file" : "files"} copied`);
  if (event.deleted > 0) parts.push(`${event.deleted} deleted`);
  if (event.failed > 0) parts.push(`${event.failed} failed`);
  if (event.cancelled > 0) parts.push(`${event.cancelled} cancelled`);
  if (event.skipped > 0) parts.push(`${event.skipped} skipped`);
  if (event.kept > 0) parts.push(`${event.kept} not deleted`);
  const summary = parts.join(", ");
  const problem = event.failed > 0 || event.cancelled > 0 || event.kept > 0;
  if (!problem) return ["success", `Sync finished: ${summary}`, undefined];
  const detail = event.note
    ? `${summary}. ${capitalize(event.note)}.`
    : summary;
  return ["error", "Sync finished with problems", detail];
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
