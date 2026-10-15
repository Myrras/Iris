import { describe, expect, it } from "vitest";

import {
  formatOctalMode,
  parseOctalMode,
  permissionBit,
  withPermission,
} from "./mode";

describe("permission modes", () => {
  it("maps grid cells to bits", () => {
    expect(permissionBit("owner", "read")).toBe(0o400);
    expect(permissionBit("group", "write")).toBe(0o020);
    expect(permissionBit("other", "execute")).toBe(0o001);
  });

  it("switches single cells", () => {
    expect(withPermission(0o644, "owner", "execute", true)).toBe(0o744);
    expect(withPermission(0o644, "group", "read", false)).toBe(0o604);
    expect(withPermission(0o4755, "other", "read", false)).toBe(0o4751);
  });

  it("parses 3- and 4-digit octal and rejects the rest", () => {
    expect(parseOctalMode("755")).toBe(0o755);
    expect(parseOctalMode(" 0644 ")).toBe(0o644);
    expect(parseOctalMode("4755")).toBe(0o4755);
    expect(parseOctalMode("75")).toBeNull();
    expect(parseOctalMode("789")).toBeNull();
    expect(parseOctalMode("77777")).toBeNull();
    expect(parseOctalMode("rwx")).toBeNull();
  });

  it("formats without the type bits", () => {
    expect(formatOctalMode(0o100644)).toBe("644");
    expect(formatOctalMode(0o040700)).toBe("700");
    expect(formatOctalMode(0o5)).toBe("005");
    expect(formatOctalMode(0o104755)).toBe("4755");
  });
});
