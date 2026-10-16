import { describe, expect, it } from "vitest";

import type { Entry } from "../ipc/types";
import {
  createTypeAheadBuffer,
  matchTypeAhead,
  TYPE_AHEAD_RESET_MS,
} from "./typeAhead";

const e = (name: string): Entry => ({
  name,
  path: `/${name}`,
  kind: { type: "file" },
  size: 0,
  mtime: null,
  mode: null,
  hidden: false,
});
const list = ["Applications", "Desktop", "Documents", "Library", "Movies"].map(
  e,
);

describe("matchTypeAhead", () => {
  it("finds the first name with the prefix, case-insensitively", () => {
    expect(matchTypeAhead(list, "L")).toBe(3);
    expect(matchTypeAhead(list, "li")).toBe(3);
    expect(matchTypeAhead(list, "Do")).toBe(2);
    expect(matchTypeAhead(list, "d")).toBe(1);
  });

  it("follows the given (display) order", () => {
    expect(matchTypeAhead([...list].reverse(), "d")).toBe(2); // Documents first
  });

  it("ignores accents", () => {
    expect(matchTypeAhead([e("Émile"), e("Zed")], "em")).toBe(0);
  });

  it("falls back to the entry sorting right after the buffer", () => {
    expect(matchTypeAhead(list, "Dz")).toBe(3); // Library
    expect(matchTypeAhead(list, "a")).toBe(0);
  });

  it("selects the last name when the buffer sorts after everything", () => {
    expect(matchTypeAhead(list, "z")).toBe(4);
  });

  it("returns null for an empty buffer or listing", () => {
    expect(matchTypeAhead(list, "")).toBeNull();
    expect(matchTypeAhead([], "a")).toBeNull();
  });
});

describe("createTypeAheadBuffer", () => {
  it("accumulates, expires and resets", () => {
    let t = 0;
    const buf = createTypeAheadBuffer(() => t);
    expect(buf.active()).toBe(false);
    expect(buf.push("l")).toBe("l");
    t += TYPE_AHEAD_RESET_MS - 1;
    expect(buf.active()).toBe(true);
    expect(buf.push("i")).toBe("li");
    t += TYPE_AHEAD_RESET_MS;
    expect(buf.active()).toBe(false);
    expect(buf.push("d")).toBe("d");
    buf.reset();
    expect(buf.active()).toBe(false);
  });
});
