import { describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ isMac: false, isWindows: true }));

import { fileManagerName } from "./openLocal";

describe("fileManagerName", () => {
  it("is Explorer on Windows", () => {
    expect(fileManagerName).toBe("Explorer");
  });
});
