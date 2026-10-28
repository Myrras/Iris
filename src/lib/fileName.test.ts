import { describe, expect, it } from "vitest";

import { nameError, renameSelection, uniqueName } from "./fileName";

describe("nameError", () => {
  it("accepts ordinary names", () => {
    expect(nameError("Reports 2024")).toBeNull();
    expect(nameError(".env")).toBeNull();
  });

  it("refuses empty, dot and separator names", () => {
    expect(nameError("")).not.toBeNull();
    expect(nameError("   ")).not.toBeNull();
    expect(nameError(".")).not.toBeNull();
    expect(nameError("..")).not.toBeNull();
    expect(nameError("a/b")).not.toBeNull();
    expect(nameError("a\\b")).not.toBeNull();
  });
});

describe("uniqueName", () => {
  it("numbers like Finder", () => {
    expect(uniqueName("untitled folder", new Set())).toBe("untitled folder");
    expect(
      uniqueName(
        "untitled folder",
        new Set(["untitled folder", "untitled folder 2"]),
      ),
    ).toBe("untitled folder 3");
  });
});

describe("renameSelection", () => {
  it("selects the name without its extension for files", () => {
    expect(renameSelection("report.final.pdf", false)).toEqual([0, 12]);
    expect(renameSelection("Makefile", false)).toEqual([0, 8]);
    expect(renameSelection(".bashrc", false)).toEqual([0, 7]);
  });

  it("selects everything for folders", () => {
    expect(renameSelection("photos.2024", true)).toEqual([0, 11]);
  });
});
