import { describe, expect, it } from "vitest";

import {
  cleanInput,
  completeSegment,
  completionFolder,
  goToErrorMessage,
  pickSuggestion,
  resolveGoTo,
  type ResolveOptions,
  splitForCompletion,
  usesHome,
} from "./goToPath";

const posix: ResolveOptions = {
  cwd: "/home/alice/docs",
  home: "/home/alice",
  windows: false,
};
const win: ResolveOptions = {
  cwd: "C:\\Users\\alice\\docs",
  home: "C:\\Users\\alice",
  windows: true,
};

describe("cleanInput", () => {
  it("trims whitespace and one pair of surrounding quotes", () => {
    expect(cleanInput("  /srv/app \n")).toBe("/srv/app");
    expect(cleanInput('"/srv/my app"')).toBe("/srv/my app");
    expect(cleanInput("  '/srv/my app'  ")).toBe("/srv/my app");
    expect(cleanInput('"/srv/a')).toBe('"/srv/a');
    expect(cleanInput('"')).toBe('"');
  });
});

describe("resolveGoTo (POSIX)", () => {
  const go = (text: string, extra: Partial<ResolveOptions> = {}) =>
    resolveGoTo(text, { ...posix, ...extra });

  it("keeps an absolute path", () => {
    expect(go("/var/log")).toBe("/var/log");
    expect(go("/")).toBe("/");
  });

  it("resolves relative paths against the current folder", () => {
    expect(go("sub/dir")).toBe("/home/alice/docs/sub/dir");
    expect(go("./x")).toBe("/home/alice/docs/x");
    expect(go("x")).toBe("/home/alice/docs/x");
    expect(go(".")).toBe("/home/alice/docs");
  });

  it("goes up with ..", () => {
    expect(go("..")).toBe("/home/alice");
    expect(go("../..")).toBe("/home");
    expect(go("../../a")).toBe("/home/a");
    expect(go("../../../..")).toBe("/");
    expect(go("..", { cwd: "/" })).toBe("/");
  });

  it("collapses . / .. segments, repeated slashes and a trailing slash", () => {
    expect(go("/a/./b/../c")).toBe("/a/c");
    expect(go("/a//b///c/")).toBe("/a/b/c");
    expect(go("sub//dir/")).toBe("/home/alice/docs/sub/dir");
    expect(go("/a/b/..")).toBe("/a");
    expect(go("/../a")).toBe("/a");
    expect(go("///")).toBe("/");
  });

  it("expands ~ and ~/x with the home folder", () => {
    expect(go("~")).toBe("/home/alice");
    expect(go("~/")).toBe("/home/alice");
    expect(go("~/projects/app")).toBe("/home/alice/projects/app");
    expect(go("~/../bob")).toBe("/home/bob");
    expect(go("~", { home: "/" })).toBe("/");
  });

  it("returns null for ~ without a known home", () => {
    expect(go("~", { home: null })).toBeNull();
    expect(go("~/x", { home: null })).toBeNull();
  });

  it("treats ~name and a ~ in the middle as plain names", () => {
    expect(go("~bob")).toBe("/home/alice/docs/~bob");
    expect(go("a/~")).toBe("/home/alice/docs/a/~");
  });

  it("trims whitespace and surrounding quotes", () => {
    expect(go("  /srv/app  ")).toBe("/srv/app");
    expect(go('"/srv/my app"')).toBe("/srv/my app");
    expect(go("'sub dir/x'")).toBe("/home/alice/docs/sub dir/x");
  });

  it("is null for empty input", () => {
    expect(go("")).toBeNull();
    expect(go("   ")).toBeNull();
    expect(go('""')).toBeNull();
  });

  it("keeps backslashes: they are file name characters on POSIX", () => {
    expect(go("a\\b")).toBe("/home/alice/docs/a\\b");
  });
});

describe("resolveGoTo (Windows)", () => {
  const go = (text: string, extra: Partial<ResolveOptions> = {}) =>
    resolveGoTo(text, { ...win, ...extra });

  it("accepts drive paths with either slash", () => {
    expect(go("C:\\x")).toBe("C:\\x");
    expect(go("C:/x/y")).toBe("C:\\x\\y");
    expect(go("d:\\data\\")).toBe("D:\\data");
    expect(go("C:\\")).toBe("C:\\");
    expect(go("C:/")).toBe("C:\\");
  });

  it("resolves relative paths with backslashes or slashes", () => {
    expect(go("sub\\dir")).toBe("C:\\Users\\alice\\docs\\sub\\dir");
    expect(go("sub/dir")).toBe("C:\\Users\\alice\\docs\\sub\\dir");
    expect(go(".\\x")).toBe("C:\\Users\\alice\\docs\\x");
    expect(go("..")).toBe("C:\\Users\\alice");
    expect(go("..\\..\\a")).toBe("C:\\Users\\a");
    expect(go("..\\..\\..\\..")).toBe("C:\\");
  });

  it("collapses repeated separators and a trailing one", () => {
    expect(go("C:\\a\\\\b//c\\")).toBe("C:\\a\\b\\c");
    expect(go("C:\\a\\.\\b\\..")).toBe("C:\\a");
  });

  it("takes a rooted path on the current drive", () => {
    expect(go("\\temp")).toBe("C:\\temp");
    expect(go("/temp/x")).toBe("C:\\temp\\x");
  });

  it("handles drive-relative input", () => {
    // Same drive: relative to the folder on screen.
    expect(go("C:x")).toBe("C:\\Users\\alice\\docs\\x");
    expect(go("c:..")).toBe("C:\\Users\\alice");
    expect(go("C:")).toBe("C:\\Users\\alice\\docs");
    // Another drive: its root.
    expect(go("D:data")).toBe("D:\\data");
    expect(go("D:")).toBe("D:\\");
  });

  it("expands ~ with the home folder", () => {
    expect(go("~")).toBe("C:\\Users\\alice");
    expect(go("~\\projects")).toBe("C:\\Users\\alice\\projects");
    expect(go("~/projects")).toBe("C:\\Users\\alice\\projects");
    expect(go("~", { home: null })).toBeNull();
  });

  it("trims quotes and whitespace", () => {
    expect(go('  "C:\\Program Files\\App"  ')).toBe("C:\\Program Files\\App");
  });
});

describe("usesHome", () => {
  it("detects ~ and ~/", () => {
    expect(usesHome("~")).toBe(true);
    expect(usesHome(' "~/x" ')).toBe(true);
    expect(usesHome("~bob")).toBe(false);
    expect(usesHome("a/~")).toBe(false);
    expect(usesHome("~\\x")).toBe(false);
    expect(usesHome("~\\x", true)).toBe(true);
  });
});

describe("goToErrorMessage", () => {
  it("names the common failures and passes the rest through", () => {
    expect(goToErrorMessage("notFound", "x")).toBe("No such folder");
    expect(goToErrorMessage("permissionDenied", "x")).toBe("Permission denied");
    expect(goToErrorMessage("remote", "Server said no")).toBe("Server said no");
  });
});

describe("completion", () => {
  it("splits at the last separator", () => {
    expect(splitForCompletion("../sub/do", false)).toEqual({
      head: "../sub/",
      prefix: "do",
    });
    expect(splitForCompletion("do", false)).toEqual({ head: "", prefix: "do" });
    expect(splitForCompletion("/", false)).toEqual({ head: "/", prefix: "" });
    expect(splitForCompletion("a\\b", false)).toEqual({
      head: "",
      prefix: "a\\b",
    });
    expect(splitForCompletion("a\\b", true)).toEqual({
      head: "a\\",
      prefix: "b",
    });
    expect(splitForCompletion('"/srv/a', false)).toBeNull();
  });

  it("lists the folder the head points at", () => {
    expect(completionFolder("", posix)).toBe("/home/alice/docs");
    expect(completionFolder("../", posix)).toBe("/home/alice");
    expect(completionFolder("~/p/", posix)).toBe("/home/alice/p");
    expect(completionFolder("/", posix)).toBe("/");
    expect(completionFolder("C:\\", win)).toBe("C:\\");
  });

  const FOLDERS = ["Documents", "Downloads", "Desktop", "src", "source"];
  const complete = (text: string, windows = false) =>
    completeSegment(splitForCompletion(text, windows)!, FOLDERS, windows);

  it("completes a unique match and adds the separator", () => {
    expect(complete("/home/alice/Doc")).toEqual({
      text: "/home/alice/Documents/",
      suggestions: [],
    });
    expect(complete("Des")).toEqual({ text: "Desktop/", suggestions: [] });
  });

  it("completes the common prefix of several matches and lists them", () => {
    expect(complete("/home/alice/Do")).toEqual({
      text: "/home/alice/Do",
      suggestions: ["Documents", "Downloads"],
    });
    expect(complete("s")).toEqual({
      text: "s",
      suggestions: ["source", "src"],
    });
    expect(complete("so")).toEqual({ text: "source/", suggestions: [] });
  });

  it("lists everything for an empty last segment", () => {
    expect(complete("/home/")).toEqual({
      text: "/home/",
      suggestions: ["Desktop", "Documents", "Downloads", "source", "src"],
    });
  });

  it("falls back to ignoring case without a case-sensitive match", () => {
    expect(complete("des")).toEqual({ text: "Desktop/", suggestions: [] });
    const multi = complete("DO");
    expect(multi?.suggestions).toEqual(["Documents", "Downloads"]);
    expect(multi?.text).toBe("DO");
  });

  it("returns null without a match", () => {
    expect(complete("zzz")).toBeNull();
  });

  it("takes .. as the parent folder", () => {
    expect(complete("..")).toEqual({ text: "../", suggestions: [] });
    expect(complete("a/b/..")).toEqual({ text: "a/b/../", suggestions: [] });
  });

  it("uses the separator already typed, or the platform's", () => {
    expect(complete("C:\\Users\\Des", true)?.text).toBe("C:\\Users\\Desktop\\");
    expect(complete("C:/Users/Des", true)?.text).toBe("C:/Users/Desktop/");
    expect(complete("Des", true)?.text).toBe("Desktop\\");
  });

  it("picks a suggestion", () => {
    const split = splitForCompletion("/home/alice/Do", false)!;
    expect(pickSuggestion(split, "Downloads", false)).toBe(
      "/home/alice/Downloads/",
    );
  });

  it("matches composed and decomposed names alike", () => {
    const decomposed = "Cafe\u0301";
    const out = completeSegment(
      { head: "", prefix: "Caf\u00e9" },
      [decomposed],
      false,
    );
    expect(out?.suggestions).toEqual([]);
    expect(out?.text.endsWith("/")).toBe(true);
  });
});
