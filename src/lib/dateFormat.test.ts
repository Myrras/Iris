import { describe, expect, it } from "vitest";

import { formatModified } from "./dateFormat";

describe("formatModified", () => {
  it("is empty when the time is unknown", () => {
    expect(formatModified(null)).toBe("");
  });

  it("formats unix seconds as a local date and time", () => {
    const secs = Date.UTC(2024, 2, 5, 14, 7) / 1000;
    const expected = new Date(secs * 1000).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(formatModified(secs)).toBe(expected);
    expect(formatModified(secs)).toContain("2024");
  });
});
