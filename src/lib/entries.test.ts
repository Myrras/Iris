import { describe, expect, it } from "vitest";

import type { Entry, EntryKind } from "../ipc/types";
import { isDirLike, sortEntries, visibleEntries } from "./entries";

function entry(
  name: string,
  kind: EntryKind["type"] | EntryKind = "file",
  extra: Partial<Entry> = {},
): Entry {
  return {
    name,
    path: `/srv/${name}`,
    kind: typeof kind === "string" ? ({ type: kind } as EntryKind) : kind,
    size: 0,
    mtime: null,
    mode: null,
    hidden: name.startsWith("."),
    ...extra,
  };
}

const names = (list: Entry[]) => list.map((e) => e.name);

describe("isDirLike", () => {
  it("treats folders and links to folders as folders", () => {
    expect(isDirLike(entry("a", "dir"))).toBe(true);
    expect(
      isDirLike(
        entry("l", { type: "symlink", target: "/x", targetKind: "dir" }),
      ),
    ).toBe(true);
    expect(
      isDirLike(
        entry("l", { type: "symlink", target: "/x", targetKind: "file" }),
      ),
    ).toBe(false);
    expect(
      isDirLike(
        entry("l", { type: "symlink", target: "/x", targetKind: null }),
      ),
    ).toBe(false);
    expect(isDirLike(entry("f"))).toBe(false);
  });
});

describe("sortEntries", () => {
  it("puts folders first, then sorts names naturally and case-insensitively", () => {
    const list = [
      entry("file10.txt"),
      entry("b-dir", "dir"),
      entry("File2.txt"),
      entry("a-dir", "dir"),
      entry("file1.txt"),
    ];
    expect(names(sortEntries(list, { key: "name", dir: "asc" }))).toEqual([
      "a-dir",
      "b-dir",
      "file1.txt",
      "File2.txt",
      "file10.txt",
    ]);
  });

  it("keeps folders first when descending", () => {
    const list = [entry("a"), entry("z", "dir"), entry("b"), entry("y", "dir")];
    expect(names(sortEntries(list, { key: "name", dir: "desc" }))).toEqual([
      "z",
      "y",
      "b",
      "a",
    ]);
  });

  it("sorts by size, mtime and permissions with a name tiebreak", () => {
    const list = [
      entry("big", "file", { size: 900, mtime: 30, mode: 0o100600 }),
      entry("small", "file", { size: 10, mtime: 10, mode: 0o100644 }),
      entry("mid", "file", { size: 50, mtime: 20, mode: 0o100644 }),
      entry("same", "file", { size: 50, mtime: null, mode: null }),
    ];
    expect(names(sortEntries(list, { key: "size", dir: "asc" }))).toEqual([
      "small",
      "mid",
      "same",
      "big",
    ]);
    expect(names(sortEntries(list, { key: "mtime", dir: "desc" }))).toEqual([
      "big",
      "mid",
      "small",
      "same",
    ]);
    expect(names(sortEntries(list, { key: "mode", dir: "asc" }))).toEqual([
      "same",
      "big",
      "mid",
      "small",
    ]);
  });

  it("does not mutate its input", () => {
    const list = [entry("b"), entry("a")];
    sortEntries(list, { key: "name", dir: "asc" });
    expect(names(list)).toEqual(["b", "a"]);
  });
});

describe("visibleEntries", () => {
  const list = [
    entry(".bashrc"),
    entry("Readme.md"),
    entry("src", "dir"),
    entry("notes.txt"),
    entry("hidden-attr", "file", { hidden: true }),
  ];
  const sort = { key: "name", dir: "asc" } as const;

  it("hides hidden entries unless asked", () => {
    expect(
      names(visibleEntries(list, { showHidden: false, filter: "", sort })),
    ).toEqual(["src", "notes.txt", "Readme.md"]);
    expect(
      names(visibleEntries(list, { showHidden: true, filter: "", sort })),
    ).toEqual(["src", ".bashrc", "hidden-attr", "notes.txt", "Readme.md"]);
  });

  it("filters names case-insensitively, trimmed", () => {
    expect(
      names(visibleEntries(list, { showHidden: false, filter: " RE ", sort })),
    ).toEqual(["Readme.md"]);
    expect(
      names(visibleEntries(list, { showHidden: true, filter: "bash", sort })),
    ).toEqual([".bashrc"]);
  });
});
