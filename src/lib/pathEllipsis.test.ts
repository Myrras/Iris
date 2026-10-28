import { describe, expect, it } from "vitest";

import { charsThatFit, ellipsizePath } from "./pathEllipsis";

describe("ellipsizePath", () => {
  it("leaves a path that fits unchanged", () => {
    expect(ellipsizePath("/var/www/site", 40)).toBe("/var/www/site");
    expect(ellipsizePath("/var/www/site", 13)).toBe("/var/www/site");
  });

  it("cuts the middle and never exceeds the limit", () => {
    const path = "/Users/me/projects/client/website/src/components/forms";
    for (const max of [16, 24, 32, 40]) {
      const out = ellipsizePath(path, max);
      expect(Array.from(out).length).toBeLessThanOrEqual(max);
      expect(out).toContain("…");
      expect(out.startsWith("/Users")).toBe(true);
      expect(out.endsWith("forms")).toBe(true);
    }
    expect(ellipsizePath(path, 32)).toBe("/Users/me…/components/forms");
  });

  it("keeps the last segment, cutting it only when it alone is too long", () => {
    expect(ellipsizePath("/a/b/c/d/e/folder", 14).endsWith("/folder")).toBe(
      true,
    );
    const out = ellipsizePath("/srv/an-extremely-long-folder-name-here", 16);
    expect(Array.from(out).length).toBeLessThanOrEqual(16);
    expect(out).toContain("…");
    expect(out.endsWith("here")).toBe(true);
  });

  it("counts characters, not UTF-16 units", () => {
    const path = "/Users/zoë/Projekte/日本語のフォルダ/画像/🙂🙂🙂";
    const out = ellipsizePath(path, 20);
    expect(Array.from(out).length).toBeLessThanOrEqual(20);
    expect(out.endsWith("🙂🙂🙂")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(ellipsizePath("/日本語/画像", 20)).toBe("/日本語/画像");
  });

  it("handles Windows paths", () => {
    const out = ellipsizePath(
      "C:\\Users\\me\\Documents\\Projects\\site\\assets",
      28,
    );
    expect(out.startsWith("C:\\Users")).toBe(true);
    expect(out.endsWith("\\assets")).toBe(true);
    expect(out).toContain("…");
  });

  it("degrades for tiny limits", () => {
    expect(ellipsizePath("/a/b/c", 1)).toBe("…");
  });
});

describe("charsThatFit", () => {
  it("converts a width and has a floor", () => {
    expect(charsThatFit(640, 6.4)).toBe(100);
    expect(charsThatFit(0)).toBe(8);
  });
});
