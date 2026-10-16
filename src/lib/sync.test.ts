import { describe, expect, it } from "vitest";

import type { SyncGroup, SyncItem, SyncPlan, SyncTotal } from "../ipc/types";
import { DEFAULTS } from "../state/settingsStore";
import {
  defaultTicks,
  deleteNames,
  finishedToast,
  isActionable,
  planOptions,
  runCounts,
  sectionCount,
  sectionLabel,
  sectionTicked,
  setSectionTicks,
  setTick,
  tickedPaths,
} from "./sync";

function item(
  path: string,
  kind: SyncItem["kind"],
  group: SyncGroup,
  selected: boolean,
  size = 10,
): SyncItem {
  return {
    path,
    kind,
    group,
    srcSize: kind === "file" && group !== "targetOnly" ? size : null,
    srcMtime: null,
    dstSize: group === "targetOnly" && kind === "file" ? size : null,
    dstMtime: null,
    reason: null,
    selected,
  };
}

function plan(items: SyncItem[], mode: SyncPlan["mode"] = "update"): SyncPlan {
  const groups: SyncGroup[] = [
    "new",
    "changed",
    "same",
    "targetNewer",
    "differentSizeSameDate",
    "targetOnly",
    "typeMismatch",
    "excluded",
    "skipped",
  ];
  const totals = Object.fromEntries(
    groups.map((g) => [g, { files: 0, dirs: 0, bytes: 0 }]),
  ) as Record<SyncGroup, SyncTotal>;
  for (const i of items) {
    const t = totals[i.group];
    if (i.kind === "dir") t.dirs += 1;
    else t.files += 1;
    t.bytes += (i.group === "targetOnly" ? i.dstSize : i.srcSize) ?? 0;
  }
  return {
    planId: "plan-1",
    sessionId: "s-1",
    direction: "upload",
    mode,
    localDir: "/home/alice/site",
    remoteDir: "/srv/site",
    items,
    totals,
  };
}

describe("sync rules", () => {
  it("only copy groups, and target-only items in Mirror, can be ticked", () => {
    for (const g of [
      "new",
      "changed",
      "targetNewer",
      "differentSizeSameDate",
    ] as const) {
      expect(isActionable(g, "update")).toBe(true);
    }
    expect(isActionable("targetOnly", "update")).toBe(false);
    expect(isActionable("targetOnly", "mirror")).toBe(true);
    for (const g of ["same", "typeMismatch", "excluded", "skipped"] as const) {
      expect(isActionable(g, "mirror")).toBe(false);
    }
  });

  it("starts from the plan's default ticks", () => {
    const p = plan([
      item("a.txt", "file", "new", true),
      item("b.txt", "file", "targetNewer", false),
      item("c.txt", "file", "targetOnly", true),
    ]);
    // A target-only item is not actionable in Update, whatever it says.
    expect([...defaultTicks(p)]).toEqual(["a.txt"]);
  });

  it("a folder tick takes its contents of the same group along", () => {
    const p = plan([
      item("docs", "dir", "new", true),
      item("docs/a.txt", "file", "new", true),
      item("docs/b.txt", "file", "changed", true),
      item("docs-old.txt", "file", "new", true),
    ]);
    const ticks = setTick(defaultTicks(p), p, p.items[0], false);
    expect([...ticks].sort()).toEqual(["docs-old.txt", "docs/b.txt"]);
    expect(tickedPaths(p, ticks)).toEqual(["docs/b.txt", "docs-old.txt"]);
  });

  it("ticks whole sections and counts them", () => {
    const p = plan([
      item("a.txt", "file", "targetNewer", false),
      item("b.txt", "file", "targetNewer", false),
    ]);
    let ticks = defaultTicks(p);
    expect(sectionTicked(ticks, p, "targetNewer")).toEqual({
      ticked: 0,
      total: 2,
    });
    ticks = setSectionTicks(ticks, p, "targetNewer", true);
    expect(sectionTicked(ticks, p, "targetNewer").ticked).toBe(2);
  });

  it("counts copies, folders and deletes of a run", () => {
    const p = plan(
      [
        item("new", "dir", "new", true),
        item("new/a.txt", "file", "new", true),
        item("old", "dir", "targetOnly", true),
        item("old/b.txt", "file", "targetOnly", true),
      ],
      "mirror",
    );
    const ticks = defaultTicks(p);
    expect(runCounts(p, ticks)).toEqual({ copies: 1, folders: 1, deletes: 2 });
    expect(deleteNames(p, ticks)).toEqual(["old/"]);
    ticks.delete("old");
    expect(deleteNames(p, ticks)).toEqual(["old/b.txt"]);
  });

  it("labels sections by mode and direction", () => {
    expect(sectionLabel("targetOnly", "mirror", "upload")).toBe(
      "Will be deleted",
    );
    expect(sectionLabel("targetOnly", "update", "upload")).toBe(
      "Only on Remote (kept)",
    );
    expect(sectionLabel("targetNewer", "update", "download")).toBe(
      "Newer on Local",
    );
    expect(sectionLabel("changed", "update", "upload", true)).toBe(
      "Overwritten",
    );
  });

  it("sums a section's totals", () => {
    const p = plan([
      item("d", "dir", "new", true),
      item("d/a.txt", "file", "new", true, 1024),
      item("d/b.txt", "file", "new", true, 1024),
    ]);
    expect(sectionCount(p, "new")).toBe("2 files, 1 folder · 2.0 KB");
  });

  it("builds the plan options from the remembered prefs", () => {
    const prefs = { ...DEFAULTS.sync };
    expect(planOptions("mirror", prefs, false)).toEqual({
      mode: "mirror",
      rule: "sizeOrDate",
      protectNewer: true,
      skipHidden: true,
      copyEmptyFolders: true,
      maxFileSizeMb: null,
    });
    // "Skip hidden" follows the panes until it is changed.
    expect(planOptions("update", prefs, true).skipHidden).toBe(false);
    expect(
      planOptions("update", { ...prefs, skipHidden: false }, false).skipHidden,
    ).toBe(false);
    expect(
      planOptions("update", { ...prefs, limitSize: true, maxSizeMb: 5 }, true)
        .maxFileSizeMb,
    ).toBe(5);
  });

  it("words the finished toast", () => {
    const base = {
      type: "syncFinished",
      planId: "plan-1",
      batchId: "b-1",
      sessionId: "s-1",
      direction: "upload",
      copied: 1,
      skipped: 0,
      failed: 0,
      cancelled: 0,
      deleted: 0,
      kept: 0,
      note: null,
    } as const;
    expect(finishedToast(base)).toEqual([
      "success",
      "Sync finished: 1 file copied",
      undefined,
    ]);
    expect(
      finishedToast({
        ...base,
        kept: 1,
        note: "1 item changed since the comparison and was kept",
      }),
    ).toEqual([
      "error",
      "Sync finished with problems",
      "1 file copied, 1 not deleted. 1 item changed since the comparison and was kept.",
    ]);
  });
});
