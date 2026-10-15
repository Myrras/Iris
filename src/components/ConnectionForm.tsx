/**
 * Create or edit a saved connection: name, host, port, user, authentication
 * (password, a private key file picked with the native dialog, the SSH agent,
 * or a `~/.ssh/config` host that prefills the fields), an optional start
 * folder and an optional jump host (a saved connection, a config host or any
 * `user@host:port`). Layout and seeding follow Selene's ConnectionDialog.
 *
 * Problems show inline under their field once the user tried to save (and
 * update live from then on); a backend rejection shows inline at the bottom.
 * No secret is entered here: passwords and passphrases are asked for at
 * connect time, where they can be remembered in the keychain; editing a
 * connection can forget them again.
 */

import { useCallback, useEffect, useState } from "react";

import { clearSecret, listSshConfigHosts, toIpcError } from "../ipc/commands";
import type { SshConfigHost } from "../ipc/types";
import { connectProfile } from "../lib/connect";
import {
  applyConfigHost,
  formFromProfile,
  formToInput,
  validateForm,
  type AuthKind,
  type ConnectionFormValues,
  type JumpChoice,
} from "../lib/connectionForm";
import { useConnectionFormStore } from "../state/connectionFormStore";
import { useProfilesStore } from "../state/profilesStore";
import { Modal } from "./Modal";
import styles from "./ConnectionForm.module.css";

/** Props that keep macOS/WebKit from "helping" with hostnames and paths. */
const PLAIN_INPUT = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
} as const;

const AUTH_OPTIONS: [AuthKind, string][] = [
  ["password", "Password"],
  ["keyFile", "Key file"],
  ["agent", "SSH agent"],
  ["sshConfigHost", "SSH config"],
];

const AUTH_HINTS: Record<AuthKind, string> = {
  password:
    "Asked when connecting; you can choose to remember it in your keychain.",
  keyFile:
    "A passphrase-protected key asks for its passphrase when connecting.",
  agent: "Uses the keys loaded in your running SSH agent.",
  sshConfigHost:
    "Uses the host's IdentityFile keys, then your SSH agent. What ~/.ssh/config sets for host, port and user wins over the fields above.",
};

/** The file name of a path, for compact summaries. */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function ConnectionForm() {
  const open = useConnectionFormStore((s) => s.open);
  const editing = useConnectionFormStore((s) => s.editing);
  const closeForm = useConnectionFormStore((s) => s.close);
  const profiles = useProfilesStore((s) => s.profiles);

  const [form, setForm] = useState<ConnectionFormValues>(() =>
    formFromProfile(editing),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "connect">(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // `~/.ssh/config` hosts for the config-host and jump pickers; `null` until
  // loaded (re-read each time the dialog opens, so config edits show up).
  const [configHosts, setConfigHosts] = useState<SshConfigHost[] | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    listSshConfigHosts()
      .then((hosts) => {
        if (!live) return;
        setConfigHosts(hosts);
        setConfigError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setConfigHosts([]);
        setConfigError(toIpcError(e).message);
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Re-seed whenever the dialog opens (Selene's pattern): `undefined` means
  // "not seeded for this opening", so the first render after opening always
  // seeds, for a new connection (`null`) as well as an edit.
  const [seededFor, setSeededFor] = useState<string | null | undefined>(
    undefined,
  );
  if (!open && seededFor !== undefined) setSeededFor(undefined);
  if (open && seededFor !== (editing?.id ?? null)) {
    setForm(formFromProfile(editing));
    setSubmitted(false);
    setSaveError(null);
    setForgotten(false);
    setSeededFor(editing?.id ?? null);
  }

  const errors = submitted ? validateForm(form) : {};

  function field<K extends keyof ConnectionFormValues>(
    key: K,
    value: ConnectionFormValues[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const close = useCallback(() => {
    if (busy === null) closeForm();
  }, [busy, closeForm]);

  async function browseKeyFile() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: "Choose a private key",
      });
      if (typeof picked === "string") field("keyPath", picked);
    } catch (e) {
      setSaveError(toIpcError(e).message);
    }
  }

  function pickConfigHost(alias: string) {
    const host = configHosts?.find((h) => h.alias === alias);
    setForm((f) =>
      host ? applyConfigHost(f, host) : { ...f, configAlias: alias },
    );
  }

  /** Forget the password and passphrase remembered for this connection. */
  async function forgetSecrets() {
    if (!editing) return;
    setSaveError(null);
    try {
      await clearSecret(editing.id, "password");
      await clearSecret(editing.id, "passphrase");
      setForgotten(true);
    } catch (e) {
      setSaveError(toIpcError(e).message);
    }
  }

  async function save(thenConnect: boolean) {
    setSubmitted(true);
    setSaveError(null);
    if (Object.keys(validateForm(form)).length > 0) return;
    setBusy(thenConnect ? "connect" : "save");
    try {
      const saved = await useProfilesStore
        .getState()
        .save(formToInput(form, editing?.id));
      closeForm();
      if (thenConnect) void connectProfile(saved);
    } catch (e) {
      setSaveError(toIpcError(e).message);
    } finally {
      setBusy(null);
    }
  }

  /** Label + input + inline error for one text field. */
  function textField(
    key: "name" | "host" | "port" | "user" | "startDir",
    label: string,
    extra: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) {
    const id = `conn-${key}`;
    const error = errors[key];
    return (
      <div className={styles.field}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          value={form[key]}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => field(key, e.target.value)}
          {...PLAIN_INPUT}
          {...extra}
        />
        {error && (
          <small id={`${id}-error`} className={styles.fieldError}>
            {error}
          </small>
        )}
      </div>
    );
  }

  /** The `~/.ssh/config` host picker and what it resolves to. */
  function configHostField() {
    const error = errors.configAlias;
    const picked = configHosts?.find((h) => h.alias === form.configAlias);
    const known = configHosts ?? [];
    const missing =
      form.configAlias && !known.some((h) => h.alias === form.configAlias);
    return (
      <div className={styles.field}>
        <label htmlFor="conn-configAlias">Host from SSH config</label>
        <select
          id="conn-configAlias"
          value={form.configAlias}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "conn-configAlias-error" : undefined}
          onChange={(e) => pickConfigHost(e.target.value)}
        >
          <option value="">
            {configHosts === null ? "Loading…" : "Choose a host…"}
          </option>
          {known.map((h) => (
            <option key={h.alias} value={h.alias}>
              {h.alias}
            </option>
          ))}
          {missing && (
            <option value={form.configAlias}>
              {form.configAlias} (not in your config)
            </option>
          )}
        </select>
        {error && (
          <small id="conn-configAlias-error" className={styles.fieldError}>
            {error}
          </small>
        )}
        {!error && picked && (
          <small className={styles.hint}>
            {picked.identityFiles.length > 0
              ? `Keys: ${picked.identityFiles.map(baseName).join(", ")}`
              : "No IdentityFile: uses your SSH agent"}
            {picked.proxyJump ? ` · via ${picked.proxyJump}` : ""}
          </small>
        )}
        {!error && configHosts?.length === 0 && (
          <small className={styles.hint}>
            {configError ?? "No hosts found in ~/.ssh/config."}
          </small>
        )}
      </div>
    );
  }

  /** The optional jump host: none, a saved connection, a config host, or typed. */
  function jumpField() {
    const error = errors.jumpCustom;
    const others = profiles.filter((p) => p.id !== editing?.id);
    const aliases = (configHosts ?? []).map((h) => h.alias);
    const choice = form.jumpChoice;
    const unknownProfile =
      choice.startsWith("profile:") &&
      !others.some((p) => `profile:${p.id}` === choice);
    const unknownAlias =
      choice.startsWith("alias:") &&
      !aliases.includes(choice.slice("alias:".length));
    const configJump =
      form.authKind === "sshConfigHost" && choice === ""
        ? configHosts?.find((h) => h.alias === form.configAlias)?.proxyJump
        : null;
    return (
      <div className={styles.field}>
        <label htmlFor="conn-jump">Jump host (optional)</label>
        <select
          id="conn-jump"
          value={choice}
          onChange={(e) => field("jumpChoice", e.target.value as JumpChoice)}
        >
          <option value="">None: connect directly</option>
          {others.length > 0 && (
            <optgroup label="Saved connections">
              {others.map((p) => (
                <option key={p.id} value={`profile:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {aliases.length > 0 && (
            <optgroup label="SSH config hosts">
              {aliases.map((a) => (
                <option key={a} value={`alias:${a}`}>
                  {a}
                </option>
              ))}
            </optgroup>
          )}
          {unknownProfile && (
            <option value={choice}>(deleted connection)</option>
          )}
          {unknownAlias && (
            <option value={choice}>{choice.slice("alias:".length)}</option>
          )}
          <option value="custom">Other host…</option>
        </select>
        {choice === "custom" && (
          <input
            id="conn-jumpCustom"
            className={styles.below}
            aria-label="Jump host address"
            value={form.jumpCustom}
            placeholder="user@bastion.example.com:22"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "conn-jumpCustom-error" : undefined}
            onChange={(e) => field("jumpCustom", e.target.value)}
            {...PLAIN_INPUT}
          />
        )}
        {error && (
          <small id="conn-jumpCustom-error" className={styles.fieldError}>
            {error}
          </small>
        )}
        {!error && (
          <small className={styles.hint}>
            {configJump
              ? `~/.ssh/config already jumps via ${configJump}.`
              : "Reach the server through another SSH host (ProxyJump)."}
          </small>
        )}
      </div>
    );
  }

  const footer = (
    <>
      <button type="button" onClick={close} disabled={busy !== null}>
        Cancel
      </button>
      <button
        type="button"
        onClick={() => void save(false)}
        disabled={busy !== null}
      >
        {busy === "save" ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        className="primary"
        onClick={() => void save(true)}
        disabled={busy !== null}
      >
        {busy === "connect" ? "Saving…" : "Save & Connect"}
      </button>
    </>
  );

  const keyError = errors.keyPath;

  return (
    <Modal
      open={open}
      title={editing ? "Edit connection" : "New connection"}
      onClose={close}
      footer={footer}
      width={500}
    >
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        {textField("name", "Name (optional)", { placeholder: "user@host" })}

        <div className={styles.row}>
          <div className={styles.grow}>
            {textField("host", "Host", { placeholder: "server.example.com" })}
          </div>
          <div className={styles.narrow}>
            {textField("port", "Port", {
              placeholder: "22",
              inputMode: "numeric",
            })}
          </div>
        </div>

        {textField("user", "User")}

        <div className={styles.field}>
          <span className={styles.groupLabel} id="conn-auth-label">
            Authentication
          </span>
          <div
            className={styles.segmented}
            role="radiogroup"
            aria-labelledby="conn-auth-label"
          >
            {AUTH_OPTIONS.map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={form.authKind === kind}
                className={styles.segment}
                data-active={form.authKind === kind ? "true" : undefined}
                onClick={() => field("authKind", kind)}
              >
                {label}
              </button>
            ))}
          </div>
          <small className={styles.hint}>{AUTH_HINTS[form.authKind]}</small>
        </div>

        {form.authKind === "keyFile" && (
          <div className={styles.field}>
            <label htmlFor="conn-keyPath">Private key</label>
            <div className={styles.fileRow}>
              <input
                id="conn-keyPath"
                className={styles.grow}
                value={form.keyPath}
                placeholder="/Users/you/.ssh/id_ed25519"
                aria-invalid={keyError ? true : undefined}
                aria-describedby={keyError ? "conn-keyPath-error" : undefined}
                onChange={(e) => field("keyPath", e.target.value)}
                {...PLAIN_INPUT}
              />
              <button type="button" onClick={() => void browseKeyFile()}>
                Browse…
              </button>
            </div>
            {keyError && (
              <small id="conn-keyPath-error" className={styles.fieldError}>
                {keyError}
              </small>
            )}
          </div>
        )}

        {form.authKind === "sshConfigHost" && configHostField()}

        {textField("startDir", "Start folder (optional)", {
          placeholder: "Your home folder on the server",
        })}

        {jumpField()}

        {editing && editing.auth.kind !== "agent" && (
          <div className={styles.forgetRow}>
            <button
              type="button"
              className="ghost"
              onClick={() => void forgetSecrets()}
              disabled={busy !== null || forgotten}
            >
              Forget saved password and passphrase
            </button>
            {forgotten && (
              <small className={styles.hint} role="status">
                Removed from your keychain.
              </small>
            )}
          </div>
        )}

        {saveError && (
          <p className={styles.saveError} role="alert">
            {saveError}
          </p>
        )}
        {/* Submit on Enter without a visible default button. */}
        <button type="submit" className="visually-hidden" tabIndex={-1}>
          Save and connect
        </button>
      </form>
    </Modal>
  );
}
