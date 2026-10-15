/**
 * Host key verification dialogs.
 *
 * - `HostKeyDialog`: a server whose key is not in `~/.ssh/known_hosts`. Shows
 *   host, key type and the `SHA256:` fingerprint to compare out of band;
 *   Trust records the key and lets the connect continue, Cancel rejects it.
 * - `HostKeyChangedDialog`: the key differs from the recorded one. A blocking
 *   warning with no way to connect anyway.
 */

import { useCallback, useState } from "react";

import { answerHostKey, toIpcError } from "../ipc/commands";
import { usePromptStore, type Prompt } from "../state/promptStore";
import { toastError } from "../state/toastStore";
import { Modal } from "./Modal";
import { HostKeyChangedIcon, HostKeyUnknownIcon } from "./icons";
import styles from "./Prompts.module.css";

type HostKeyEntry = Extract<Prompt, { kind: "hostKey" }>;
type HostKeyChangedEntry = Extract<Prompt, { kind: "hostKeyChanged" }>;

/** `[::1]:22`-style address; IPv6 literals get brackets. */
function address(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function HostKeyDialog({ prompt }: { prompt: HostKeyEntry | null }) {
  const resolve = usePromptStore((s) => s.resolve);
  const [busy, setBusy] = useState(false);
  // Keep the last prompt on screen while the dialog animates closed.
  const [shown, setShown] = useState<HostKeyEntry | null>(prompt);
  if (prompt && prompt.id !== shown?.id) {
    setShown(prompt);
    setBusy(false);
  }

  const answer = useCallback(
    async (trust: boolean) => {
      if (!shown || busy) return;
      setBusy(true);
      try {
        await answerHostKey(shown.event.requestId, trust);
      } catch (e) {
        // Usually the backend already gave up waiting (timeout).
        toastError(
          "Could not answer the host key prompt",
          toIpcError(e).message,
        );
      } finally {
        resolve(shown.id);
        setBusy(false);
      }
    },
    [shown, busy, resolve],
  );
  const cancel = useCallback(() => void answer(false), [answer]);

  const event = shown?.event;
  return (
    <Modal
      open={prompt !== null}
      title="Unknown host key"
      tone="warning"
      onClose={cancel}
      width={480}
      footer={
        <>
          <button type="button" onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void answer(true)}
            disabled={busy}
          >
            Trust
          </button>
        </>
      }
    >
      <div className={styles.hostKey}>
        <HostKeyUnknownIcon className={styles.hostKeyIcon} />
        <div className={styles.hostKeyBody}>
          <p className={styles.intro}>
            Iris has not connected to{" "}
            <strong className={styles.mono}>
              {event && address(event.host, event.port)}
            </strong>{" "}
            before. Check that the fingerprint matches the server's before you
            trust it.
          </p>
          <dl className={styles.facts}>
            <dt>Key type</dt>
            <dd className={styles.mono}>{event?.keyType}</dd>
            <dt>Fingerprint</dt>
            <dd className={`${styles.mono} ${styles.fingerprint}`}>
              {event?.fingerprintSha256}
            </dd>
          </dl>
          <small className={styles.hint}>
            Trusting adds the key to ~/.ssh/known_hosts.
          </small>
        </div>
      </div>
    </Modal>
  );
}

export function HostKeyChangedDialog({
  prompt,
}: {
  prompt: HostKeyChangedEntry | null;
}) {
  const resolve = usePromptStore((s) => s.resolve);
  const [shown, setShown] = useState<HostKeyChangedEntry | null>(prompt);
  if (prompt && prompt.id !== shown?.id) setShown(prompt);
  const close = useCallback(() => {
    if (shown) resolve(shown.id);
  }, [shown, resolve]);

  return (
    <Modal
      open={prompt !== null}
      title="Host key changed"
      tone="danger"
      onClose={close}
      width={480}
      footer={
        <button type="button" className="primary" onClick={close}>
          Close
        </button>
      }
    >
      <div className={styles.hostKey}>
        <HostKeyChangedIcon
          className={`${styles.hostKeyIcon} ${styles.danger}`}
        />
        <div className={styles.hostKeyBody}>
          <p className={styles.intro}>
            The server for <strong>{shown?.profileName}</strong> presented a
            different host key than the one recorded in ~/.ssh/known_hosts. This
            can mean the server was reinstalled, or that someone is intercepting
            the connection. Iris did not connect.
          </p>
          <p className={styles.intro}>
            If you expected the change, remove the old key from
            ~/.ssh/known_hosts and connect again.
          </p>
          {shown?.message && <p className={styles.error}>{shown.message}</p>}
        </div>
      </div>
    </Modal>
  );
}
