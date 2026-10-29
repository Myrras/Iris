import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listProfiles: vi.fn(),
  reorderProfiles: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock("./toastStore", () => ({ toastError: vi.fn() }));

import {
  deleteProfile,
  listProfiles,
  reorderProfiles,
  saveProfile,
} from "../ipc/commands";
import type { ConnectionProfile } from "../ipc/types";
import { useProfilesStore } from "./profilesStore";
import { toastError } from "./toastStore";

const alpha: ConnectionProfile = {
  id: "p-1",
  name: "Alpha",
  host: "alpha.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "password" },
  startDir: null,
  jump: null,
  favorites: [],
};

const beta: ConnectionProfile = { ...alpha, id: "p-2", name: "Beta" };
const gamma: ConnectionProfile = { ...alpha, id: "p-3", name: "Gamma" };
const ids = () => useProfilesStore.getState().profiles.map((p) => p.id);

beforeEach(() => {
  vi.clearAllMocks();
  useProfilesStore.setState({ profiles: [], loaded: false });
});

describe("profilesStore", () => {
  it("loads the saved connections from the backend", async () => {
    vi.mocked(listProfiles).mockResolvedValue([alpha]);
    await useProfilesStore.getState().refresh();
    expect(useProfilesStore.getState()).toMatchObject({
      profiles: [alpha],
      loaded: true,
    });
  });

  it("toasts and keeps the list when loading fails", async () => {
    useProfilesStore.setState({ profiles: [alpha], loaded: true });
    vi.mocked(listProfiles).mockRejectedValue({ kind: "io", message: "boom" });
    await useProfilesStore.getState().refresh();
    expect(useProfilesStore.getState().profiles).toEqual([alpha]);
    expect(toastError).toHaveBeenCalledWith(
      "Could not load connections",
      "boom",
    );
  });

  it("saves, then re-reads the list instead of guessing", async () => {
    vi.mocked(saveProfile).mockResolvedValue(alpha);
    vi.mocked(listProfiles).mockResolvedValue([alpha]);
    const input = {
      name: "",
      host: "alpha.example.test",
      user: "alice",
      auth: alpha.auth,
    };
    await expect(useProfilesStore.getState().save(input)).resolves.toEqual(
      alpha,
    );
    expect(saveProfile).toHaveBeenCalledWith(input);
    expect(useProfilesStore.getState().profiles).toEqual([alpha]);
  });

  it("propagates a rejected save to the caller", async () => {
    vi.mocked(saveProfile).mockRejectedValue({
      kind: "invalidInput",
      message: "host must be a non-empty name without spaces",
    });
    await expect(
      useProfilesStore
        .getState()
        .save({ name: "", host: " ", user: "a", auth: alpha.auth }),
    ).rejects.toMatchObject({ kind: "invalidInput" });
  });

  it("deletes, then re-reads the list", async () => {
    useProfilesStore.setState({ profiles: [alpha], loaded: true });
    vi.mocked(deleteProfile).mockResolvedValue(undefined);
    vi.mocked(listProfiles).mockResolvedValue([]);
    await useProfilesStore.getState().remove("p-1");
    expect(deleteProfile).toHaveBeenCalledWith("p-1");
    expect(useProfilesStore.getState().profiles).toEqual([]);
  });

  describe("reorder", () => {
    it("applies the order at once, sends it, then re-reads the list", async () => {
      useProfilesStore.setState({ profiles: [alpha, beta, gamma] });
      let sent!: () => void;
      vi.mocked(reorderProfiles).mockReturnValue(
        new Promise<void>((resolve) => (sent = resolve)),
      );
      vi.mocked(listProfiles).mockResolvedValue([gamma, alpha, beta]);
      const done = useProfilesStore.getState().reorder(["p-3", "p-1", "p-2"]);
      // Local first: the UI does not wait for the backend.
      expect(ids()).toEqual(["p-3", "p-1", "p-2"]);
      expect(listProfiles).not.toHaveBeenCalled();
      sent();
      await done;
      expect(reorderProfiles).toHaveBeenCalledWith(["p-3", "p-1", "p-2"]);
      expect(listProfiles).toHaveBeenCalledTimes(1);
      expect(ids()).toEqual(["p-3", "p-1", "p-2"]);
    });

    it("follows the backend when it ends up with another order", async () => {
      useProfilesStore.setState({ profiles: [alpha, beta] });
      vi.mocked(reorderProfiles).mockResolvedValue(undefined);
      vi.mocked(listProfiles).mockResolvedValue([alpha, beta]);
      await useProfilesStore.getState().reorder(["p-2", "p-1"]);
      expect(ids()).toEqual(["p-1", "p-2"]);
    });

    it("reverts and toasts when the backend refuses, without rejecting", async () => {
      useProfilesStore.setState({ profiles: [alpha, beta] });
      vi.mocked(reorderProfiles).mockRejectedValue({
        kind: "invalidInput",
        message: "unknown connection",
      });
      vi.mocked(listProfiles).mockResolvedValue([alpha, beta]);
      await useProfilesStore.getState().reorder(["p-2", "p-1"]);
      expect(ids()).toEqual(["p-1", "p-2"]);
      expect(toastError).toHaveBeenCalledWith(
        "Could not reorder connections",
        "unknown connection",
      );
    });

    it("keeps the previous list when reverting cannot re-read it either", async () => {
      useProfilesStore.setState({ profiles: [alpha, beta] });
      vi.mocked(reorderProfiles).mockRejectedValue({
        kind: "io",
        message: "disk full",
      });
      vi.mocked(listProfiles).mockRejectedValue({ kind: "io", message: "x" });
      await useProfilesStore.getState().reorder(["p-2", "p-1"]);
      expect(ids()).toEqual(["p-1", "p-2"]);
    });

    it("lets only the latest of two quick reorders revert or refresh", async () => {
      useProfilesStore.setState({ profiles: [alpha, beta, gamma] });
      let failFirst!: (e: unknown) => void;
      vi.mocked(reorderProfiles)
        .mockReturnValueOnce(
          new Promise<void>((_, reject) => (failFirst = reject)),
        )
        .mockResolvedValueOnce(undefined);
      vi.mocked(listProfiles).mockResolvedValue([beta, gamma, alpha]);
      const first = useProfilesStore.getState().reorder(["p-2", "p-1", "p-3"]);
      const second = useProfilesStore.getState().reorder(["p-2", "p-3", "p-1"]);
      await second;
      failFirst({ kind: "io", message: "late" });
      await first;
      // The late failure of the first must not undo the second.
      expect(ids()).toEqual(["p-2", "p-3", "p-1"]);
      expect(toastError).not.toHaveBeenCalled();
    });
  });
});
