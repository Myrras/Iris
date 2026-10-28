import { describe, expect, it } from "vitest";

import { formatModified, formatModifiedFull } from "./dateFormat";

const now = new Date(2026, 9, 15, 12, 0);
const secs = (d: Date) => d.getTime() / 1000;

describe("formatModified", () => {
  it("is empty when the time is unknown", () => {
    expect(formatModified(null, now)).toBe("");
    expect(formatModifiedFull(null)).toBe("");
  });

  it("shows day, month and time for this year (no year)", () => {
    const d = new Date(2026, 9, 14, 16, 15);
    const label = formatModified(secs(d), now);
    expect(label).toBe(
      `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
    );
    expect(label).not.toContain("2026");
  });

  it("shows day, month and year for another year (no time)", () => {
    const d = new Date(2024, 2, 5, 14, 7);
    const label = formatModified(secs(d), now);
    expect(label).toBe(
      d.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    );
    expect(label).toContain("2024");
  });

  it("gives the full date and time for the tooltip", () => {
    const d = new Date(2024, 2, 5, 14, 7);
    expect(formatModifiedFull(secs(d))).toContain("2024");
  });
});
