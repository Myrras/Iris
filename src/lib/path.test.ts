import { describe, expect, it } from "vitest";

import {
  baseName,
  childToward,
  joinPath,
  parentPath,
  pathSegments,
} from "./path";

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

describe("joinPath / baseName", () => {
  it("joins with the parent's separator", () => {
    expect(joinPath("/srv", "a")).toBe("/srv/a");
    expect(joinPath("/", "a")).toBe("/a");
    expect(joinPath("C:\\Users\\alice", "a")).toBe("C:\\Users\\alice\\a");
    expect(joinPath("C:\\", "a")).toBe("C:\\a");
  });

  it("takes the last segment", () => {
    expect(baseName("/srv/data/report.pdf")).toBe("report.pdf");
    expect(baseName("C:\\Users\\alice")).toBe("alice");
    expect(baseName("/")).toBe("/");
  });
});

describe("childToward", () => {
  it("returns the child of the ancestor on the way to path", () => {
    expect(childToward("/a", "/a/b/c")).toBe("/a/b");
    expect(childToward("/a/b", "/a/b/c")).toBe("/a/b/c");
    expect(childToward("/", "/a")).toBe("/a");
    expect(childToward("C:\\", "C:\\x\\y")).toBe("C:\\x");
  });

  it("is null for the same, a sibling or a deeper ancestor", () => {
    expect(childToward("/a/b", "/a/b")).toBeNull();
    expect(childToward("/a/b", "/a/x/c")).toBeNull();
    expect(childToward("/a/b/c", "/a")).toBeNull();
    expect(childToward("/a/B", "/a/b/c")).toBeNull();
  });
});
