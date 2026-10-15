/**
 * The connection form's values, inline validation and conversion to the
 * `saveProfile` input. Validation mirrors the backend's rules
 * (`ConnectionProfile::normalized`) so mistakes show next to the field before
 * a round trip; the backend still has the final word.
 */

import type { ConnectionProfile, ConnectionProfileInput } from "../ipc/types";

export type AuthKind = "password" | "keyFile";

export interface ConnectionFormValues {
  name: string;
  host: string;
  /** Text as typed; blank means 22. */
  port: string;
  user: string;
  authKind: AuthKind;
  keyPath: string;
  startDir: string;
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
    startDir: "",
  };
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
    startDir: profile.startDir ?? "",
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
  return errors;
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
    auth:
      form.authKind === "keyFile"
        ? { kind: "keyFile", path: form.keyPath.trim() }
        : { kind: "password" },
    startDir: form.startDir.trim() || null,
  };
}
