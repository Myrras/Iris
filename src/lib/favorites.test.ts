import { describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ isMac: true, isWindows: false }));

import { favoriteLabel, isFavorite, wantsNewTab } from "./favorites";

describe("favorites", () => {
  it("shows the label, else the folder name (Local) or the path (Remote)", () => {
    const local = { kind: "local" } as const;
    const remote = { kind: "remote", profileId: "p-1" } as const;
    expect(
      favoriteLabel({ path: "/home/alice/projects", label: null }, local),
    ).toBe("projects");
    expect(favoriteLabel({ path: "/var/www", label: null }, remote)).toBe(
      "/var/www",
    );
    expect(favoriteLabel({ path: "/var/www", label: "site" }, remote)).toBe(
      "site",
    );
  });

  it("matches folders by their exact path", () => {
    const list = [{ path: "/var/www", label: "site" }];
    expect(isFavorite(list, "/var/www")).toBe(true);
    expect(isFavorite(list, "/var/www/html")).toBe(false);
  });

  it("opens in a new tab on ⌘-click on macOS", () => {
    expect(wantsNewTab({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(wantsNewTab({ metaKey: false, ctrlKey: true })).toBe(false);
  });
});
