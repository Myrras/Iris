/**
 * Create or edit a saved connection: name, host, port, user, authentication
 * (password, or a private key file picked with the native dialog) and an
 * optional start folder. Layout and seeding follow Selene's ConnectionDialog.
 *
 * Problems show inline under their field once the user tried to save (and
 * update live from then on); a backend rejection shows inline at the bottom.
 * No secret is entered here: passwords and passphrases are asked for at
 * connect time and never stored.
 */

import { useCallback, useState } from "react";

import { toIpcError } from "../ipc/commands";
import { connectProfile } from "../lib/connect";
import {
  formFromProfile,
  formToInput,
  validateForm,
  type AuthKind,
  type ConnectionFormValues,
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
];

export function ConnectionForm() {
  const open = useConnectionFormStore((s) => s.open);
  const editing = useConnectionFormStore((s) => s.editing);
  const closeForm = useConnectionFormStore((s) => s.close);

  const [form, setForm] = useState<ConnectionFormValues>(() =>
    formFromProfile(editing),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "connect">(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
          <small className={styles.hint}>
            {form.authKind === "password"
              ? "You enter the password each time you connect; it is never stored."
              : "A passphrase-protected key asks for its passphrase when connecting."}
          </small>
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

        {textField("startDir", "Start folder (optional)", {
          placeholder: "Your home folder on the server",
        })}

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
