/**
 * "Enter the password / passphrase to connect" prompt, after Selene's
 * PasswordPrompt. Driven by a `secret` entry in the prompt queue: it calls the
 * entry's `attempt`, stays open with the error inline when the secret is
 * wrong, and leaves the queue once the connect succeeded or was cancelled.
 *
 * It stays mounted while hidden: a host key question can jump in front of a
 * running attempt, and the busy state must survive until it comes back.
 *
 * "Remember in keychain" (Selene's toggle style) stores the secret in the OS
 * keychain once the connect succeeded; the backend does the storing.
 *
 * SECURITY: the typed value lives only in this component's state, is cleared
 * the moment it is handed to `attempt`, and is never logged.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { toIpcError } from "../ipc/commands";
import { usePromptStore, type Prompt } from "../state/promptStore";
import { Modal } from "./Modal";
import styles from "./Prompts.module.css";

type SecretPromptEntry = Extract<Prompt, { kind: "secret" }>;

export function SecretPrompt({ prompt }: { prompt: SecretPromptEntry | null }) {
  const resolve = usePromptStore((s) => s.resolve);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(prompt?.rememberByDefault ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the last prompt for the exit animation, and reset the form when a
  // different prompt arrives (not when the same one comes back into view).
  const [shown, setShown] = useState<SecretPromptEntry | null>(prompt);
  if (prompt && prompt.id !== shown?.id) {
    setShown(prompt);
    setValue("");
    setRemember(prompt.rememberByDefault ?? false);
    setError(null);
    setBusy(false);
  }

  const open = prompt !== null;
  useEffect(() => {
    if (!open) return;
    // After the modal focused its card on open.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, shown?.id]);

  // Stable identity: this is Modal's `onClose` (see Selene's note).
  const cancel = useCallback(() => {
    if (busy || !shown) return;
    setValue("");
    shown.onCancel();
    resolve(shown.id);
  }, [busy, shown, resolve]);

  async function submit() {
    if (!shown || busy || !value) return;
    const secret = value;
    setValue("");
    setBusy(true);
    setError(null);
    try {
      await shown.attempt(secret, remember);
      resolve(shown.id);
    } catch (e) {
      setError(toIpcError(e).message);
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  const isPassword = shown?.secret !== "passphrase";
  const noun = isPassword ? "Password" : "Key passphrase";

  return (
    <Modal
      open={open}
      title={isPassword ? "Password required" : "Passphrase required"}
      onClose={cancel}
      width={420}
      footer={
        <>
          <button type="button" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void submit()}
            disabled={busy || !value}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className={styles.intro}>
          {isPassword ? "Enter the password for " : "Enter the passphrase of "}
          {isPassword ? (
            <>
              <span className={styles.mono}>
                {shown?.profile.user}@{shown?.profile.host}
              </span>{" "}
              (<strong>{shown?.profile.name}</strong>).
            </>
          ) : (
            <>
              the key for <strong>{shown?.profile.name}</strong>.
            </>
          )}
        </p>
        {shown?.notice && <p className={styles.notice}>{shown.notice}</p>}
        <div className={styles.field}>
          <label htmlFor="prompt-secret">{noun}</label>
          <input
            id="prompt-secret"
            ref={inputRef}
            type="password"
            value={value}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={remember}
            disabled={busy}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>
            Remember in keychain
            <small>
              Stored in your system keychain once the connection works.
            </small>
          </span>
        </label>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {/* Submit on Enter without a visible default button. */}
        <button type="submit" className="visually-hidden" tabIndex={-1}>
          Submit {noun.toLowerCase()}
        </button>
      </form>
    </Modal>
  );
}
