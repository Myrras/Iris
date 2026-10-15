import { describe, expect, it } from "vitest";

import { clickSelection, moveCursor } from "./selection";

const paths = ["a", "b", "c", "d", "e"];
const none = { meta: false, shift: false };

describe("clickSelection", () => {
  it("selects only the clicked row on a plain click", () => {
    expect(
      clickSelection({ selection: ["a", "b"], anchor: "a" }, paths, "c", none),
    ).toEqual({ selection: ["c"], anchor: "c", cursor: "c" });
  });

  it("toggles a row with Cmd/Ctrl", () => {
    const meta = { meta: true, shift: false };
    expect(
      clickSelection({ selection: ["a"], anchor: "a" }, paths, "c", meta),
    ).toEqual({ selection: ["a", "c"], anchor: "c", cursor: "c" });
    expect(
      clickSelection({ selection: ["a", "c"], anchor: "c" }, paths, "a", meta),
    ).toEqual({ selection: ["c"], anchor: "a", cursor: "a" });
  });

  it("selects the range from the anchor with Shift", () => {
    const shift = { meta: false, shift: true };
    expect(
      clickSelection({ selection: ["b"], anchor: "b" }, paths, "d", shift),
    ).toEqual({ selection: ["b", "c", "d"], anchor: "b", cursor: "d" });
    expect(
      clickSelection({ selection: ["d"], anchor: "d" }, paths, "b", shift),
    ).toEqual({ selection: ["b", "c", "d"], anchor: "d", cursor: "b" });
  });

  it("treats Shift without a visible anchor as a plain click", () => {
    expect(
      clickSelection({ selection: [], anchor: "gone" }, paths, "b", {
        meta: false,
        shift: true,
      }),
    ).toEqual({ selection: ["b"], anchor: "b", cursor: "b" });
  });
});

describe("moveCursor", () => {
  it("starts at the first row when nothing is focused", () => {
    expect(
      moveCursor(
        { selection: [], anchor: null, cursor: null },
        paths,
        1,
        false,
      ),
    ).toEqual({ selection: ["a"], anchor: "a", cursor: "a" });
  });

  it("moves the cursor and selects that row", () => {
    expect(
      moveCursor(
        { selection: ["b"], anchor: "b", cursor: "b" },
        paths,
        1,
        false,
      ),
    ).toEqual({ selection: ["c"], anchor: "c", cursor: "c" });
    expect(
      moveCursor(
        { selection: ["b"], anchor: "b", cursor: "b" },
        paths,
        -1,
        false,
      ),
    ).toEqual({ selection: ["a"], anchor: "a", cursor: "a" });
  });

  it("clamps at both ends", () => {
    expect(
      moveCursor(
        { selection: ["a"], anchor: "a", cursor: "a" },
        paths,
        -1,
        false,
      ).cursor,
    ).toBe("a");
    expect(
      moveCursor(
        { selection: ["e"], anchor: "e", cursor: "e" },
        paths,
        1,
        false,
      ).cursor,
    ).toBe("e");
  });

  it("extends the range from the anchor with Shift", () => {
    const step1 = moveCursor(
      { selection: ["b"], anchor: "b", cursor: "b" },
      paths,
      1,
      true,
    );
    expect(step1).toEqual({ selection: ["b", "c"], anchor: "b", cursor: "c" });
    const step2 = moveCursor(step1, paths, 1, true);
    expect(step2).toEqual({
      selection: ["b", "c", "d"],
      anchor: "b",
      cursor: "d",
    });
  });

  it("does nothing on an empty list", () => {
    expect(
      moveCursor({ selection: [], anchor: null, cursor: null }, [], 1, false),
    ).toEqual({ selection: [], anchor: null, cursor: null });
  });
});
