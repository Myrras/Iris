import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  openRemote: vi.fn(() => Promise.resolve("e-1")),
}));
vi.mock("../state/toastStore", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import { openRemote } from "../ipc/commands";
import type { Entry } from "../ipc/types";
import { toastError } from "../state/toastStore";
import { isEditable, openForEdit } from "./edit";

const entry = (kind: Entry["kind"]): Entry => ({
  name: "x",
  path: "/srv/x",
  kind,
  size: 1,
  mtime: null,
  mode: null,
  hidden: false,
});

beforeEach(() => vi.clearAllMocks());

describe("remote edit helpers", () => {
  it("edits files and links to files only", () => {
    expect(isEditable(entry({ type: "file" }))).toBe(true);
    expect(
      isEditable(entry({ type: "symlink", target: "y", targetKind: "file" })),
    ).toBe(true);
    expect(isEditable(entry({ type: "dir" }))).toBe(false);
    expect(
      isEditable(entry({ type: "symlink", target: "y", targetKind: "dir" })),
    ).toBe(false);
    expect(
      isEditable(entry({ type: "symlink", target: null, targetKind: null })),
    ).toBe(false);
    expect(isEditable(entry({ type: "other" }))).toBe(false);
  });

  it("opens once while a double double-click is in flight", async () => {
    let finish: (id: string) => void = () => undefined;
    vi.mocked(openRemote).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const first = openForEdit("s-1", "/srv/notes.txt");
    expect(await openForEdit("s-1", "/srv/notes.txt")).toBe(false);
    finish("e-1");
    expect(await first).toBe(true);
    expect(openRemote).toHaveBeenCalledTimes(1);
  });

  it("toasts why a file could not be opened", async () => {
    vi.mocked(openRemote).mockRejectedValueOnce({
      kind: "config",
      message: "config error: could not open the file with /Applications/X.app",
    });
    expect(await openForEdit("s-1", "/srv/notes.txt")).toBe(false);
    expect(toastError).toHaveBeenCalledWith(
      "Could not open notes.txt",
      "config error: could not open the file with /Applications/X.app",
    );
  });
});
