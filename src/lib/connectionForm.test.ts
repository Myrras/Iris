import { describe, expect, it } from "vitest";

import type { ConnectionProfile, SshConfigHost } from "../ipc/types";
import {
  applyConfigHost,
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

  it("needs nothing extra for agent authentication", () => {
    expect(validateForm({ ...valid, authKind: "agent" })).toEqual({});
  });

  it("requires a config host for SSH config authentication", () => {
    const config = { ...valid, authKind: "sshConfigHost" as const };
    expect(validateForm(config).configAlias).toBe(
      "Choose a host from your SSH config.",
    );
    expect(validateForm({ ...config, configAlias: "web" })).toEqual({});
  });

  it("requires a custom jump host without spaces", () => {
    const custom = { ...valid, jumpChoice: "custom" as const };
    expect(validateForm(custom).jumpCustom).toBe("Enter the jump host.");
    expect(validateForm({ ...custom, jumpCustom: "a b" }).jumpCustom).toBe(
      "A jump host has no spaces.",
    );
    expect(
      validateForm({ ...custom, jumpCustom: "ops@bastion.example.test:2222" }),
    ).toEqual({});
  });
});

describe("applyConfigHost", () => {
  const host: SshConfigHost = {
    alias: "web",
    hostName: "web.example.test",
    user: "deploy",
    port: 2200,
    identityFiles: ["/home/alice/.ssh/id_web"],
    proxyJump: null,
  };

  it("fills host, port and user from the config", () => {
    const form = applyConfigHost(
      { ...emptyForm(), authKind: "sshConfigHost", name: "" },
      host,
    );
    expect(form).toMatchObject({
      configAlias: "web",
      host: "web.example.test",
      port: "2200",
      user: "deploy",
      name: "",
    });
  });

  it("keeps typed values the config leaves open", () => {
    const form = applyConfigHost(
      { ...valid, port: "2022" },
      { ...host, hostName: null, user: null, port: null },
    );
    expect(form).toMatchObject({
      host: "web",
      port: "2022",
      user: "alice",
    });
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
      jump: null,
    });
  });

  it("builds agent and SSH config logins", () => {
    expect(formToInput({ ...valid, authKind: "agent" }).auth).toEqual({
      kind: "agent",
    });
    expect(
      formToInput({ ...valid, authKind: "sshConfigHost", configAlias: " web " })
        .auth,
    ).toEqual({ kind: "sshConfigHost", alias: "web" });
  });

  it("builds each kind of jump host", () => {
    const jump = (form: Partial<typeof valid>) =>
      formToInput({ ...valid, ...form }).jump;
    expect(jump({ jumpChoice: "" })).toBeNull();
    expect(jump({ jumpChoice: "profile:p-9" })).toEqual({
      kind: "profile",
      profileId: "p-9",
    });
    expect(jump({ jumpChoice: "alias:bastion" })).toEqual({
      kind: "alias",
      alias: "bastion",
    });
    expect(
      jump({ jumpChoice: "custom", jumpCustom: " ops@gate.example.test " }),
    ).toEqual({ kind: "alias", alias: "ops@gate.example.test" });
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
      jump: null,
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
      jump: { kind: "profile", profileId: "p-2" },
    };
    const form = formFromProfile(profile);
    expect(form.port).toBe("2222");
    expect(form.jumpChoice).toBe("profile:p-2");
    expect(formToInput(form, profile.id)).toEqual(profile);

    const viaConfig: ConnectionProfile = {
      ...profile,
      auth: { kind: "sshConfigHost", alias: "web" },
      jump: { kind: "alias", alias: "bastion" },
    };
    expect(formToInput(formFromProfile(viaConfig), profile.id)).toEqual(
      viaConfig,
    );
  });

  it("starts empty for a new connection", () => {
    expect(formFromProfile(null)).toEqual(emptyForm());
  });
});
