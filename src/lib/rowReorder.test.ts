import { describe, expect, it } from "vitest";

import {
  EDGE_SCROLL_PX,
  MAX_SCROLL_STEP,
  edgeScrollDelta,
  effectiveInsert,
  insertionIndex,
  moveBy,
  moveToInsertion,
} from "./rowReorder";

describe("insertionIndex", () => {
  const mids = [14, 42, 70];

  it("counts the rows whose centre is above the pointer", () => {
    expect(insertionIndex(mids, 0)).toBe(0);
    expect(insertionIndex(mids, 20)).toBe(1);
    expect(insertionIndex(mids, 42)).toBe(1);
    expect(insertionIndex(mids, 43)).toBe(2);
    expect(insertionIndex(mids, 999)).toBe(3);
    expect(insertionIndex([], 5)).toBe(0);
  });
});

describe("effectiveInsert", () => {
  it("is null right before or after the row itself", () => {
    expect(effectiveInsert(1, 1)).toBeNull();
    expect(effectiveInsert(1, 2)).toBeNull();
    expect(effectiveInsert(1, 0)).toBe(0);
    expect(effectiveInsert(1, 3)).toBe(3);
    expect(effectiveInsert(0, 0)).toBeNull();
    expect(effectiveInsert(2, 3)).toBeNull();
  });
});

describe("moveToInsertion", () => {
  const abcd = ["a", "b", "c", "d"];

  it("moves a row down and up", () => {
    expect(moveToInsertion(abcd, 0, 3)).toEqual(["b", "c", "a", "d"]);
    expect(moveToInsertion(abcd, 0, 4)).toEqual(["b", "c", "d", "a"]);
    expect(moveToInsertion(abcd, 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveToInsertion(abcd, 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("keeps the order for the no-op insertions and does not mutate", () => {
    expect(moveToInsertion(abcd, 1, 1)).toEqual(abcd);
    expect(moveToInsertion(abcd, 1, 2)).toEqual(abcd);
    expect(abcd).toEqual(["a", "b", "c", "d"]);
  });
});

describe("moveBy", () => {
  it("swaps with the neighbour", () => {
    expect(moveBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveBy(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("is null at the ends and for an unknown id", () => {
    expect(moveBy(["a", "b"], "a", -1)).toBeNull();
    expect(moveBy(["a", "b"], "b", 1)).toBeNull();
    expect(moveBy(["a", "b"], "z", 1)).toBeNull();
    expect(moveBy(["a"], "a", 1)).toBeNull();
  });
});

describe("edgeScrollDelta", () => {
  it("is zero away from the edges", () => {
    expect(edgeScrollDelta(100, 0, 200)).toBe(0);
    expect(edgeScrollDelta(EDGE_SCROLL_PX, 0, 200)).toBe(0);
  });

  it("scrolls toward the edge, faster the closer, capped beyond it", () => {
    const near = edgeScrollDelta(EDGE_SCROLL_PX - 4, 0, 200);
    const close = edgeScrollDelta(2, 0, 200);
    expect(near).toBeLessThan(0);
    expect(close).toBeLessThan(near);
    expect(edgeScrollDelta(-500, 0, 200)).toBe(-MAX_SCROLL_STEP);
    expect(edgeScrollDelta(200 - EDGE_SCROLL_PX + 4, 0, 200)).toBeGreaterThan(
      0,
    );
    expect(edgeScrollDelta(900, 0, 200)).toBe(MAX_SCROLL_STEP);
  });
});
