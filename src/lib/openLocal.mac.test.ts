import { describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ isMac: true, isWindows: false }));

import { fileManagerName } from "./openLocal";

describe("fileManagerName", () => {
  it("is Finder on macOS", () => {
    expect(fileManagerName).toBe("Finder");
  });
});
