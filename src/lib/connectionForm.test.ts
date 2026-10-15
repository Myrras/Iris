import { describe, expect, it } from "vitest";

import type { ConnectionProfile } from "../ipc/types";
import {
  emptyForm,
  formFromProfile,
  formToInput,
  validateForm,
  type ConnectionFormValues,
} from "./connectionForm";

const valid: ConnectionFormValues = {
  ...emptyForm(),
  host: "alpha.example.test",
  user: "alice",
};

describe("validateForm", () => {
  it("accepts a minimal password connection", () => {
    expect(validateForm(valid)).toEqual({});
  });

  it("requires a host without spaces", () => {
    expect(validateForm({ ...valid, host: "  " }).host).toBe("Enter a host.");
    expect(validateForm({ ...valid, host: "a b" }).host).toBe(
      "A host has no spaces.",
    );
  });

  it("requires a user", () => {
    expect(validateForm({ ...valid, user: " " }).user).toBe(
      "Enter a user name.",
    );
  });

  it("accepts a blank port (22) or 1–65535", () => {
    expect(validateForm({ ...valid, port: "" }).port).toBeUndefined();
    expect(validateForm({ ...valid, port: "2222" }).port).toBeUndefined();
    for (const port of ["0", "65536", "22.5", "abc", "-1"]) {
      expect(validateForm({ ...valid, port }).port).toBe(
        "Use a port from 1 to 65535.",
      );
    }
  });

  it("requires a full key file path for key authentication", () => {
    const key = { ...valid, authKind: "keyFile" as const };
    expect(validateForm(key).keyPath).toBe("Choose a key file.");
    expect(validateForm({ ...key, keyPath: "~/.ssh/id_example" }).keyPath).toBe(
      "Use the full path; ~ is not expanded.",
    );
    expect(
      validateForm({ ...key, keyPath: "/home/alice/.ssh/id_example" }),
    ).toEqual({});
  });

  it("ignores the key path for password authentication", () => {
    expect(validateForm({ ...valid, keyPath: "~/x" })).toEqual({});
  });
});

describe("formToInput", () => {
  it("trims, defaults the port and drops a blank start folder", () => {
    expect(
      formToInput({
        ...valid,
        name: "  ",
        host: " alpha.example.test ",
        user: " alice ",
        startDir: "  ",
      }),
    ).toEqual({
      name: "",
      host: "alpha.example.test",
      user: "alice",
      auth: { kind: "password" },
      startDir: null,
    });
  });

  it("carries the id, port, key file and start folder", () => {
    expect(
      formToInput(
        {
          ...valid,
          name: "Alpha",
          port: "2222",
          authKind: "keyFile",
          keyPath: " /home/alice/.ssh/id_example ",
          startDir: "/srv",
        },
        "p-1",
      ),
    ).toEqual({
      id: "p-1",
      name: "Alpha",
      host: "alpha.example.test",
      port: 2222,
      user: "alice",
      auth: { kind: "keyFile", path: "/home/alice/.ssh/id_example" },
      startDir: "/srv",
    });
  });
});

describe("formFromProfile", () => {
  it("round-trips a saved profile", () => {
    const profile: ConnectionProfile = {
      id: "p-1",
      name: "Alpha",
      host: "alpha.example.test",
      port: 2222,
      user: "alice",
      auth: { kind: "keyFile", path: "/home/alice/.ssh/id_example" },
      startDir: "/srv",
    };
    const form = formFromProfile(profile);
    expect(form.port).toBe("2222");
    expect(formToInput(form, profile.id)).toEqual(profile);
  });

  it("starts empty for a new connection", () => {
    expect(formFromProfile(null)).toEqual(emptyForm());
  });
});
