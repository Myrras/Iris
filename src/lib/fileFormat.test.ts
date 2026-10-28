import { describe, expect, it } from "vitest";

import { formatPermissions, formatSize } from "./fileFormat";

describe("formatSize", () => {
  it("shows bytes below one kilobyte", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1)).toBe("1 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("uses one decimal below 100 of a unit", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024 + 300 * 1024)).toBe("5.3 MB");
  });

  it("drops the decimal from 100 of a unit", () => {
    expect(formatSize(150 * 1024)).toBe("150 KB");
    expect(formatSize(1023.9 * 1024)).toBe("1024 KB");
  });

  it("scales up to terabytes", () => {
    expect(formatSize(2 * 1024 ** 3)).toBe("2.0 GB");
    expect(formatSize(3 * 1024 ** 4)).toBe("3.0 TB");
    expect(formatSize(2048 * 1024 ** 4)).toBe("2048 TB");
  });
});

describe("formatPermissions", () => {
  it("is empty when the mode is unknown", () => {
    expect(formatPermissions(null)).toBe("");
  });

  it("renders a directory", () => {
    expect(formatPermissions(0o040755)).toBe("drwxr-xr-x");
  });

  it("renders a regular file", () => {
    expect(formatPermissions(0o100644)).toBe("-rw-r--r--");
    expect(formatPermissions(0o100600)).toBe("-rw-------");
  });

  it("renders a symlink and the special file types", () => {
    expect(formatPermissions(0o120777)).toBe("lrwxrwxrwx");
    expect(formatPermissions(0o020620)).toBe("crw--w----");
    expect(formatPermissions(0o060660)).toBe("brw-rw----");
    expect(formatPermissions(0o010644)).toBe("prw-r--r--");
    expect(formatPermissions(0o140755)).toBe("srwxr-xr-x");
  });

  it("falls back to '-' for permission-only bits", () => {
    expect(formatPermissions(0o755)).toBe("-rwxr-xr-x");
  });

  it("shows setuid, setgid and sticky with and without execute", () => {
    expect(formatPermissions(0o104755)).toBe("-rwsr-xr-x");
    expect(formatPermissions(0o104644)).toBe("-rwSr--r--");
    expect(formatPermissions(0o102755)).toBe("-rwxr-sr-x");
    expect(formatPermissions(0o102745)).toBe("-rwxr-Sr-x");
    expect(formatPermissions(0o041777)).toBe("drwxrwxrwt");
    expect(formatPermissions(0o041776)).toBe("drwxrwxrwT");
  });
});
