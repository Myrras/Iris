import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  listProfiles: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock("./toastStore", () => ({ toastError: vi.fn() }));

import { deleteProfile, listProfiles, saveProfile } from "../ipc/commands";
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
};

beforeEach(() => {
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
});
