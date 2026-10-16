import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  openLocal: vi.fn(() => Promise.resolve()),
  revealLocal: vi.fn(() => Promise.resolve()),
}));

import { openLocal, revealLocal } from "../ipc/commands";
import { useToastStore } from "../state/toastStore";
import { openLocalFile, revealLocalPath } from "./openLocal";

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
});

describe("openLocalFile", () => {
  it("opens once while the first call is in flight", async () => {
    let finish: () => void = () => undefined;
    vi.mocked(openLocal).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const first = openLocalFile("/Users/alice/a.csv");
    expect(await openLocalFile("/Users/alice/a.csv")).toBe(false);
    finish();
    expect(await first).toBe(true);
    expect(openLocal).toHaveBeenCalledTimes(1);
  });

  it("toasts the file name and the core's message, not the path", async () => {
    vi.mocked(openLocal).mockRejectedValueOnce({
      kind: "notFound",
      message: "not found: a.csv",
    });
    expect(await openLocalFile("/Users/alice/a.csv")).toBe(false);
    const [toast] = useToastStore.getState().toasts;
    expect(toast.message).toBe("Could not open a.csv");
    expect(toast.detail).toBe("not found: a.csv");
  });
});

describe("revealLocalPath", () => {
  it("toasts a failure naming the file manager", async () => {
    vi.mocked(revealLocal).mockRejectedValueOnce({
      kind: "config",
      message: "could not show the item in the file manager",
    });
    expect(await revealLocalPath("/Users/alice/a.csv")).toBe(false);
    expect(useToastStore.getState().toasts[0].message).toBe(
      "Could not show a.csv in File Manager",
    );
  });
});
