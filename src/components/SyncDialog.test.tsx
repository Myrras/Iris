import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  planSync: vi.fn(),
  runSync: vi.fn(() => Promise.resolve("b-1")),
  discardSyncPlan: vi.fn(() => Promise.resolve()),
  listTransfers: vi.fn(() => new Promise(() => undefined)),
}));

const progress = vi.hoisted(() => ({
  handler: null as null | ((e: SyncProgressEvent) => void),
}));
vi.mock("../ipc/events", () => ({
  onSyncProgress: vi.fn((handler: (e: SyncProgressEvent) => void) => {
    progress.handler = handler;
    return Promise.resolve(() => {
      progress.handler = null;
    });
  }),
}));

import { discardSyncPlan, planSync, runSync } from "../ipc/commands";
import type {
  SyncGroup,
  SyncItem,
  SyncPlan,
  SyncProgressEvent,
  SyncTotal,
  TransferDirection,
} from "../ipc/types";
import { initialPane, usePaneStore } from "../state/paneStore";
import { DEFAULTS, useSettingsStore } from "../state/settingsStore";
import { useSyncStore } from "../state/syncStore";
import { stubViewport } from "../test/viewport";
import { SyncDialog } from "./SyncDialog";

stubViewport();

const GROUPS: SyncGroup[] = [
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

function item(
  path: string,
  kind: SyncItem["kind"],
  group: SyncGroup,
  selected: boolean,
  extra: Partial<SyncItem> = {},
): SyncItem {
  return {
    path,
    kind,
    group,
    srcSize: kind === "file" && group !== "targetOnly" ? 100 : null,
    srcMtime: null,
    dstSize: kind === "file" && group !== "new" ? 90 : null,
    dstMtime: null,
    reason: null,
    selected,
    ...extra,
  };
}

function plan(
  mode: SyncPlan["mode"] = "update",
  direction: TransferDirection = "upload",
  same = 4,
): SyncPlan {
  const items = [
    item("docs", "dir", "new", true),
    item("docs/a.txt", "file", "new", true),
    item("index.html", "file", "changed", true),
    item("logo.png", "file", "targetNewer", false),
    item("old.txt", "file", "targetOnly", mode === "mirror"),
    item(".git", "dir", "excluded", false, { reason: "matches “.git”" }),
  ];
  const totals = Object.fromEntries(
    GROUPS.map((g) => [g, { files: 0, dirs: 0, bytes: 0 }]),
  ) as Record<SyncGroup, SyncTotal>;
  for (const i of items) {
    if (i.kind === "dir") totals[i.group].dirs += 1;
    else totals[i.group].files += 1;
    totals[i.group].bytes += i.srcSize ?? i.dstSize ?? 0;
  }
  totals.same = { files: same, dirs: 0, bytes: 400 };
  return {
    planId: `plan-${mode}`,
    sessionId: "s-1",
    direction,
    mode,
    localDir: "/home/alice/site",
    remoteDir: "/srv/site",
    items,
    totals,
    window: null,
  };
}

function mockPlans() {
  vi.mocked(planSync).mockImplementation((_s, direction, _l, _r, options) =>
    Promise.resolve(plan(options?.mode ?? "update", direction)),
  );
}

function dialog() {
  return screen.getByRole("dialog");
}

async function compare() {
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  return screen.findByLabelText("Comparison");
}

function section(name: RegExp) {
  return screen.getByRole("button", { name }).closest("section")!;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsStore.setState({
    sync: { ...DEFAULTS.sync },
    browser: { showHidden: false },
  });
  usePaneStore.setState({
    panes: {
      local: {
        ...initialPane(),
        target: { kind: "local" },
        path: "/home/alice/site",
      },
      remote: {
        ...initialPane(),
        target: { kind: "remote", sessionId: "s-1" },
        path: "/srv/site",
      },
    },
  });
  useSyncStore.setState({ request: null });
  mockPlans();
});

describe("SyncDialog", () => {
  it("opens with the pane's direction and both full paths", () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("download"));
    const d = dialog();
    expect(
      within(d).getByRole("radio", { name: "Remote → Local" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(d).toHaveTextContent("From Remote/srv/site");
    expect(d).toHaveTextContent("To Local/home/alice/site");
    fireEvent.click(within(d).getByRole("radio", { name: "Local → Remote" }));
    expect(d).toHaveTextContent("From Local/home/alice/site");
  });

  it("compares and shows the plan grouped with counts", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    expect(screen.getByRole("radio", { name: "Update" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await compare();
    expect(planSync).toHaveBeenCalledWith(
      "s-1",
      "upload",
      "/home/alice/site",
      "/srv/site",
      {
        mode: "update",
        rule: "sizeOrDate",
        protectNewer: true,
        skipHidden: true,
        copyEmptyFolders: true,
        maxFileSizeMb: null,
        changedWithin: null,
      },
      expect.any(String),
    );
    expect(section(/^New\b/)).toHaveTextContent("1 file, 1 folder · 100 B");
    expect(section(/^Changed/)).toHaveTextContent("1 file · 100 B");
    expect(section(/^Newer on Remote/)).toBeInTheDocument();
    expect(section(/^Only on Remote \(kept\)/)).toHaveTextContent("1 file");
    expect(section(/^Skipped/)).toHaveTextContent("4 identical, 1 excluded");
    // Default ticks: new + changed, not "newer on the target".
    expect(screen.getByRole("checkbox", { name: "All of New" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "All of Newer on Remote" }),
    ).not.toBeChecked();
    // Target-only items do nothing in Update: no tick.
    expect(
      screen.queryByRole("checkbox", { name: /Only on Remote/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync (copy 2)" })).toBeEnabled();
  });

  it("unticks items, folders with their contents, and runs the rest", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    await compare();
    fireEvent.click(screen.getByRole("button", { name: /^New\b/ }));
    const list = within(section(/^New\b/));
    fireEvent.click(list.getByRole("checkbox", { name: "docs" }));
    expect(
      list.getByRole("checkbox", { name: "docs/a.txt" }),
    ).not.toBeChecked();
    // Tick one "newer on the target" file on purpose.
    fireEvent.click(screen.getByRole("button", { name: /^Newer on Remote/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "logo.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Sync (copy 2)" }));
    await waitFor(() =>
      expect(runSync).toHaveBeenCalledWith("plan-update", [
        "index.html",
        "logo.png",
      ]),
    );
    await waitFor(() => expect(useSyncStore.getState().request).toBeNull());
    // It ran: nothing to discard.
    expect(discardSyncPlan).not.toHaveBeenCalled();
  });

  it("warns about Mirror and confirms its deletes once more", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    fireEvent.click(screen.getByRole("radio", { name: "Mirror" }));
    expect(screen.getByRole("note")).toHaveTextContent(
      "permanently, from the server",
    );
    await compare();
    expect(section(/^Will be deleted/)).toHaveTextContent("1 file");
    fireEvent.click(
      screen.getByRole("button", { name: "Sync (copy 2, delete 1)" }),
    );
    // Not yet: the dialog asks first.
    expect(runSync).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Delete 1 item?" }),
    ).toHaveTextContent("old.txt");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Comparison")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Sync (copy 2, delete 1)" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Sync and delete permanently" }),
    );
    await waitFor(() =>
      expect(runSync).toHaveBeenCalledWith("plan-mirror", [
        "docs",
        "docs/a.txt",
        "index.html",
        "old.txt",
      ]),
    );
  });

  it("names the Trash for a local Mirror", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("download"));
    fireEvent.click(screen.getByRole("radio", { name: "Mirror" }));
    expect(screen.getByRole("note")).toHaveTextContent("they go to the");
    await compare();
    fireEvent.click(
      screen.getByRole("button", { name: "Sync (copy 2, delete 1)" }),
    );
    expect(
      screen.getByRole("button", { name: /^Sync and move to/ }),
    ).toBeInTheDocument();
  });

  it("compares again when the rule changes, and remembers it", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    await compare();
    expect(planSync).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("combobox", { name: "Copy when" }), {
      target: { value: "newerOnly" },
    });
    await waitFor(() => expect(planSync).toHaveBeenCalledTimes(2));
    expect(vi.mocked(planSync).mock.calls[1][4]).toMatchObject({
      rule: "newerOnly",
    });
    // The first plan is thrown away.
    expect(discardSyncPlan).toHaveBeenCalledWith("plan-update");
    expect(useSettingsStore.getState().sync.rule).toBe("newerOnly");
    expect(await screen.findByLabelText("Comparison")).toBeInTheDocument();
  });

  it("keeps the options behind a disclosure with their defaults", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    const toggle = screen.getByRole("button", { name: "Options" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("checkbox", { name: /Copy empty folders/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("checkbox", { name: /Don't overwrite files/ }),
    ).toBeChecked();
    // Follows the panes: hidden files are not shown, so they are skipped.
    expect(
      screen.getByRole("checkbox", { name: /Skip hidden files/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Copy empty folders/ }),
    ).toBeChecked();
    const limit = screen.getByRole("checkbox", {
      name: /Skip files larger than/,
    });
    expect(limit).not.toBeChecked();
    fireEvent.click(limit);
    const mb = screen.getByRole("spinbutton", { name: "Size limit in MB" });
    fireEvent.change(mb, { target: { value: "25" } });
    expect(useSettingsStore.getState().sync).toMatchObject({
      limitSize: true,
      maxSizeMb: 25,
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Skip hidden files/ }),
    );
    expect(useSettingsStore.getState().sync.skipHidden).toBe(false);

    await compare();
    expect(vi.mocked(planSync).mock.calls[0][4]).toMatchObject({
      skipHidden: false,
      maxFileSizeMb: 25,
    });
    // Newer only implies "don't overwrite newer".
    fireEvent.change(screen.getByRole("combobox", { name: "Copy when" }), {
      target: { value: "newerOnly" },
    });
    const protect = screen.getByRole("checkbox", {
      name: /Don't overwrite files/,
    });
    expect(protect).toBeChecked();
    expect(protect).toBeDisabled();
  });

  it("shows why a comparison failed and lets it be tried again", async () => {
    vi.mocked(planSync).mockRejectedValueOnce({
      kind: "notFound",
      message: "not found: /srv/site",
    });
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not found: /srv/site",
    );
    await compare();
  });

  it("shows how far the comparison's walk got", async () => {
    let finish: (p: SyncPlan) => void = () => undefined;
    vi.mocked(planSync).mockImplementationOnce(
      () => new Promise<SyncPlan>((resolve) => (finish = resolve)),
    );
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Comparing Local and Remote…",
    );
    await waitFor(() => expect(progress.handler).not.toBeNull());
    const planId = vi.mocked(planSync).mock.calls[0][5]!;
    act(() => {
      // Another comparison's progress is ignored.
      progress.handler!({
        type: "syncProgress",
        planId: "other",
        stage: "scanning",
        foldersScanned: 1,
        filesSeen: 1,
        checked: 0,
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Comparing");
    act(() => {
      progress.handler!({
        type: "syncProgress",
        planId,
        stage: "scanning",
        foldersScanned: 812,
        filesSeen: 5120,
        checked: 0,
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Scanning… 812 folders, 5,120 files",
    );
    await act(async () => finish(plan("update", "upload")));
    expect(await screen.findByLabelText("Comparison")).toBeInTheDocument();
    expect(progress.handler).toBeNull();
  });

  it("limits a comparison to recently changed files, and remembers it", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("download"));
    const field = screen.getByRole("combobox", {
      name: "Only files changed in",
    });
    expect(field).toHaveValue("any");
    fireEvent.click(screen.getByRole("radio", { name: "Mirror" }));
    expect(screen.getByRole("radio", { name: "Mirror" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.change(field, { target: { value: "hour" } });
    // Mirror needs a full comparison: off, with the reason.
    const mirror = screen.getByRole("radio", { name: "Mirror" });
    expect(mirror).toBeDisabled();
    expect(mirror).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Update" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(dialog()).toHaveTextContent(
      "deletions on Remote are not seen, so Mirror is off",
    );
    expect(useSettingsStore.getState().sync.changedWithin).toBe("hour");

    const before = Math.floor(Date.now() / 1000);
    await compare();
    const options = vi.mocked(planSync).mock.calls[0][4]!;
    expect(options.mode).toBe("update");
    const since = options.changedWithin!.sinceUnix;
    expect(since).toBeGreaterThanOrEqual(before - 3600);
    expect(since).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 3600);

    // Back to any time: everything is compared again, and Mirror is back.
    fireEvent.change(field, { target: { value: "any" } });
    await waitFor(() => expect(planSync).toHaveBeenCalledTimes(2));
    expect(vi.mocked(planSync).mock.calls[1][4]!.changedWithin).toBeNull();
    expect(screen.getByRole("radio", { name: "Mirror" })).toBeEnabled();
  });

  it("takes a date and time for Since…", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    expect(screen.queryByLabelText("Changed since")).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Only files changed in" }),
      { target: { value: "since" } },
    );
    const input = screen.getByLabelText("Changed since");
    // Starts a day back.
    expect((input as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
    fireEvent.change(input, { target: { value: "2026-10-01T08:30" } });
    expect(useSettingsStore.getState().sync.changedSince).toBe(
      "2026-10-01T08:30",
    );
    await compare();
    expect(vi.mocked(planSync).mock.calls[0][4]!.changedWithin).toEqual({
      sinceUnix: new Date(2026, 9, 1, 8, 30).getTime() / 1000,
    });
  });

  it("says how a windowed plan was found and how its search goes", async () => {
    useSettingsStore.setState({
      sync: { ...DEFAULTS.sync, changedWithin: "day" },
    });
    let finish: (p: SyncPlan) => void = () => undefined;
    vi.mocked(planSync).mockImplementationOnce(
      () => new Promise<SyncPlan>((resolve) => (finish = resolve)),
    );
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("download"));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Looking for changed files on Remote…",
    );
    await waitFor(() => expect(progress.handler).not.toBeNull());
    const planId = vi.mocked(planSync).mock.calls[0][5]!;
    const event = (stage: SyncProgressEvent["stage"], checked = 0) => ({
      type: "syncProgress" as const,
      planId,
      stage,
      foldersScanned: 0,
      filesSeen: 120,
      checked,
    });
    act(() => progress.handler!(event("searching")));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Searching the server… 120 changed files",
    );
    act(() => progress.handler!(event("checking", 40)));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking 40 of 120 changed files on Local…",
    );
    await act(async () =>
      finish({
        ...plan("update", "download"),
        window: {
          sinceUnix: 1_700_000_000,
          method: "serverFind",
          clockSkewSecs: 300,
        },
      }),
    );
    const notes = await screen.findByRole("list", { name: "Search" });
    expect(notes).toHaveTextContent("Searched on the server");
    expect(notes).toHaveTextContent("Server clock differs by 5 min (ahead)");
  });

  it("notes a fallback when the server could not search", async () => {
    useSettingsStore.setState({
      sync: { ...DEFAULTS.sync, changedWithin: "week" },
    });
    vi.mocked(planSync).mockResolvedValueOnce({
      ...plan("update", "download", 0),
      items: [],
      window: { sinceUnix: 1_700_000_000, method: "walk", clockSkewSecs: null },
    });
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("download"));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(
      await screen.findByText("Scanned folders (server search unavailable)"),
    ).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("No files changed in this window.");
  });

  it("discards an unused plan when it closes", async () => {
    render(<SyncDialog />);
    act(() => useSyncStore.getState().open("upload"));
    await compare();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(discardSyncPlan).toHaveBeenCalledWith("plan-update");
    expect(useSyncStore.getState().request).toBeNull();
  });
});
