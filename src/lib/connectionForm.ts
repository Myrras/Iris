/**
 * The connection form's values, inline validation and conversion to the
 * `saveProfile` input. Validation mirrors the backend's rules
 * (`ConnectionProfile::normalized`) so mistakes show next to the field before
 * a round trip; the backend still has the final word.
 */

import type {
  AuthMethod,
  ConnectionProfile,
  ConnectionProfileInput,
  JumpHost,
  SshConfigHost,
} from "../ipc/types";

export type AuthKind = AuthMethod["kind"];

/**
 * The jump host picker's value: `""` (none), `profile:<id>`,
 * `alias:<alias>` or `custom` (then `jumpCustom` holds the spec).
 */
export type JumpChoice =
  "" | "custom" | `profile:${string}` | `alias:${string}`;

export interface ConnectionFormValues {
  name: string;
  host: string;
  /** Text as typed; blank means 22. */
  port: string;
  user: string;
  authKind: AuthKind;
  keyPath: string;
  /** The `~/.ssh/config` host of an `sshConfigHost` login. */
  configAlias: string;
  startDir: string;
  jumpChoice: JumpChoice;
  /** `[user@]host[:port]` when `jumpChoice` is `custom`. */
  jumpCustom: string;
}

export type ConnectionFormErrors = Partial<
  Record<keyof ConnectionFormValues, string>
>;

export function emptyForm(): ConnectionFormValues {
  return {
    name: "",
    host: "",
    port: "",
    user: "",
    authKind: "password",
    keyPath: "",
    configAlias: "",
    startDir: "",
    jumpChoice: "",
    jumpCustom: "",
  };
}

function jumpChoiceOf(jump: JumpHost | null): JumpChoice {
  if (!jump) return "";
  return jump.kind === "profile"
    ? `profile:${jump.profileId}`
    : `alias:${jump.alias}`;
}

export function formFromProfile(
  profile: ConnectionProfile | null,
): ConnectionFormValues {
  if (!profile) return emptyForm();
  return {
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    user: profile.user,
    authKind: profile.auth.kind,
    keyPath: profile.auth.kind === "keyFile" ? profile.auth.path : "",
    configAlias:
      profile.auth.kind === "sshConfigHost" ? profile.auth.alias : "",
    startDir: profile.startDir ?? "",
    jumpChoice: jumpChoiceOf(profile.jump),
    jumpCustom: "",
  };
}

/**
 * The form after picking a `~/.ssh/config` host: the alias plus what the
 * config says for host, port and user (the config wins at connect time; the
 * fields are what shows and the fallback). A blank name stays blank.
 */
export function applyConfigHost(
  form: ConnectionFormValues,
  host: SshConfigHost,
): ConnectionFormValues {
  return {
    ...form,
    configAlias: host.alias,
    host: host.hostName ?? host.alias,
    port: host.port != null ? String(host.port) : form.port,
    user: host.user ?? form.user,
  };
}

/** Field → message for every problem; empty when the form can be saved. */
export function validateForm(form: ConnectionFormValues): ConnectionFormErrors {
  const errors: ConnectionFormErrors = {};
  const host = form.host.trim();
  if (!host) errors.host = "Enter a host.";
  else if (/\s/.test(host)) errors.host = "A host has no spaces.";

  const port = form.port.trim();
  if (port && !(/^\d+$/.test(port) && +port >= 1 && +port <= 65535)) {
    errors.port = "Use a port from 1 to 65535.";
  }

  if (!form.user.trim()) errors.user = "Enter a user name.";

  if (form.authKind === "keyFile") {
    const path = form.keyPath.trim();
    if (!path) errors.keyPath = "Choose a key file.";
    // The backend opens the path as-is; a shell-style `~` would not resolve.
    else if (path.startsWith("~"))
      errors.keyPath = "Use the full path; ~ is not expanded.";
  }

  if (form.authKind === "sshConfigHost" && !form.configAlias.trim()) {
    errors.configAlias = "Choose a host from your SSH config.";
  }

  if (form.jumpChoice === "custom") {
    const spec = form.jumpCustom.trim();
    if (!spec) errors.jumpCustom = "Enter the jump host.";
    else if (/\s/.test(spec)) errors.jumpCustom = "A jump host has no spaces.";
  }
  return errors;
}

function authOf(form: ConnectionFormValues): AuthMethod {
  switch (form.authKind) {
    case "keyFile":
      return { kind: "keyFile", path: form.keyPath.trim() };
    case "agent":
      return { kind: "agent" };
    case "sshConfigHost":
      return { kind: "sshConfigHost", alias: form.configAlias.trim() };
    default:
      return { kind: "password" };
  }
}

function jumpOf(form: ConnectionFormValues): JumpHost | null {
  const choice = form.jumpChoice;
  if (choice === "") return null;
  if (choice === "custom")
    return { kind: "alias", alias: form.jumpCustom.trim() };
  if (choice.startsWith("profile:")) {
    return { kind: "profile", profileId: choice.slice("profile:".length) };
  }
  return { kind: "alias", alias: choice.slice("alias:".length) };
}

/** The `saveProfile` input for a valid form (`id` to replace a profile). */
export function formToInput(
  form: ConnectionFormValues,
  id?: string,
): ConnectionProfileInput {
  const port = form.port.trim();
  return {
    ...(id ? { id } : {}),
    // Blank stays blank: the backend names it `user@host`.
    name: form.name.trim(),
    host: form.host.trim(),
    ...(port ? { port: Number(port) } : {}),
    user: form.user.trim(),
    auth: authOf(form),
    startDir: form.startDir.trim() || null,
    jump: jumpOf(form),
  };
}
