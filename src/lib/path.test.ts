import { describe, expect, it } from "vitest";

import { parentPath, pathSegments } from "./path";

describe("pathSegments", () => {
  it("splits a POSIX path into clickable segments", () => {
    expect(pathSegments("/home/alice/projects")).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "alice", path: "/home/alice" },
      { name: "projects", path: "/home/alice/projects" },
    ]);
  });

  it("returns only the root for /", () => {
    expect(pathSegments("/")).toEqual([{ name: "/", path: "/" }]);
  });

  it("ignores a trailing or doubled separator", () => {
    expect(pathSegments("/srv//www/")).toEqual([
      { name: "/", path: "/" },
      { name: "srv", path: "/srv" },
      { name: "www", path: "/srv/www" },
    ]);
  });

  it("handles a Windows drive path", () => {
    expect(pathSegments("C:\\Users\\alice")).toEqual([
      { name: "C:\\", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "alice", path: "C:\\Users\\alice" },
    ]);
  });

  it("keeps a relative path as plain segments", () => {
    expect(pathSegments("data/logs")).toEqual([
      { name: "data", path: "data" },
      { name: "logs", path: "data/logs" },
    ]);
  });
});

describe("parentPath", () => {
  it("goes one level up", () => {
    expect(parentPath("/home/alice")).toBe("/home");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("C:\\Users\\alice")).toBe("C:\\Users");
    expect(parentPath("C:\\Users")).toBe("C:\\");
  });

  it("has no parent at a root", () => {
    expect(parentPath("/")).toBeNull();
    expect(parentPath("C:\\")).toBeNull();
    expect(parentPath("data")).toBeNull();
  });
});
