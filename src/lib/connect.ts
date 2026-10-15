/**
 * The connect flow every entry point uses (sidebar row, reconnect button),
 * modelled on Selene's `lib/connect.ts`: connect, ask for what the backend
 * says is missing, and show the session in the remote pane.
 *
 * - Every profile first connects without secrets: the backend uses what the
 *   keychain remembers, the agent, or `~/.ssh/config`.
 * - `passwordRequired` / `passphraseRequired` prompt for that secret, with a
 *   "Remember in keychain" option.
 * - A remembered secret that no longer works (`authFailed` on a password
 *   profile, a wrong passphrase) prompts again with a notice and "remember"
 *   ticked, so the stored one gets replaced; unticking it forgets it.
 * - A wrong typed secret keeps the prompt open with the error; anything else
 *   closes it and is reported (a changed host key as a blocking warning).
 *
 * SECURITY: secrets pass from the prompt's local state straight into
 * `connect`; nothing here keeps or logs them.
 */

import { clearSecret, connect, disconnect, toIpcError } from "../ipc/commands";
import type { ConnectionProfile, IpcError, SessionId } from "../ipc/types";
import { usePaneStore } from "../state/paneStore";
import { usePromptStore, type SecretKind } from "../state/promptStore";
import { latestSessionFor, useSessionStore } from "../state/sessionStore";
import { toastError } from "../state/toastStore";

/** Errors a retyped secret can fix: the prompt stays open for them. */
const RETRYABLE: Record<SecretKind, ReadonlySet<string>> = {
  password: new Set(["authFailed", "passwordRequired"]),
  passphrase: new Set(["passphraseRequired", "keyFile", "authFailed"]),
};

/** Profiles with a connect in progress (a double-click must not connect twice). */
const inFlight = new Set<string>();

function showInRemotePane(sessionId: SessionId, profile: ConnectionProfile) {
  void usePaneStore
    .getState()
    .open("remote", { kind: "remote", sessionId }, profile.startDir);
}

function report(profile: ConnectionProfile, err: IpcError) {
  if (err.kind === "hostKeyRejected") return; // the user said no
  if (err.kind === "hostKeyChanged") {
    usePromptStore.getState().push({
      kind: "hostKeyChanged",
      profileName: profile.name,
      message: err.message,
    });
    return;
  }
  toastError(`Could not connect to ${profile.name}`, err.message);
}

const isWrongPassphrase = (err: IpcError) =>
  err.kind === "keyFile" && err.message.endsWith("wrong passphrase");

/**
 * The secret to ask for after a connect without one failed with `err`, and
 * whether a remembered one was just refused; `null` when no secret helps.
 */
function secretFor(
  profile: ConnectionProfile,
  err: IpcError,
): { secret: SecretKind; stale: boolean } | null {
  if (err.kind === "passwordRequired")
    return { secret: "password", stale: false };
  if (err.kind === "passphraseRequired") {
    return { secret: "passphrase", stale: false };
  }
  // Without a typed secret, these can only come from a remembered one.
  if (err.kind === "authFailed" && profile.auth.kind === "password") {
    return { secret: "password", stale: true };
  }
  if (isWrongPassphrase(err)) return { secret: "passphrase", stale: true };
  return null;
}

/** Prompt for a secret and connect with it; `null` when cancelled or failed. */
function connectWithSecret(
  profile: ConnectionProfile,
  secret: SecretKind,
  stale: boolean,
): Promise<SessionId | null> {
  return new Promise((resolve) => {
    usePromptStore.getState().push({
      kind: "secret",
      secret,
      profile,
      notice: stale
        ? `The saved ${secret} was not accepted. Enter it again to replace it.`
        : undefined,
      rememberByDefault: stale,
      attempt: async (value, remember) => {
        try {
          const sessionId = await connect(profile.id, {
            ...(secret === "password"
              ? { password: value }
              : { passphrase: value }),
            remember,
          });
          // A refused saved secret the user chose not to keep is dropped.
          if (stale && !remember) {
            void clearSecret(profile.id, secret).catch(() => undefined);
          }
          showInRemotePane(sessionId, profile);
          resolve(sessionId);
        } catch (e) {
          const err = toIpcError(e);
          // Rejecting keeps the prompt open with the message.
          if (RETRYABLE[secret].has(err.kind)) throw err;
          report(profile, err);
          resolve(null);
        }
      },
      onCancel: () => resolve(null),
    });
  });
}

/**
 * Connect `profile` and show it in the remote pane. An already connected
 * session of the profile is shown instead. Resolves with the session id, or
 * `null` when cancelled, failed (already reported) or already in progress.
 */
export async function connectProfile(
  profile: ConnectionProfile,
): Promise<SessionId | null> {
  const live = latestSessionFor(
    useSessionStore.getState().sessions,
    profile.id,
  );
  if (live?.state === "connected") {
    showInRemotePane(live.sessionId, profile);
    return live.sessionId;
  }
  if (inFlight.has(profile.id)) return null;
  inFlight.add(profile.id);
  try {
    try {
      const sessionId = await connect(profile.id);
      showInRemotePane(sessionId, profile);
      return sessionId;
    } catch (e) {
      const err = toIpcError(e);
      const ask = secretFor(profile, err);
      if (ask) return await connectWithSecret(profile, ask.secret, ask.stale);
      report(profile, err);
      return null;
    }
  } finally {
    inFlight.delete(profile.id);
  }
}

/**
 * Close a session at the user's request. The remote pane, if it showed it,
 * goes back to its welcome state (an unrequested drop shows "disconnected").
 */
export async function disconnectSession(sessionId: SessionId): Promise<void> {
  try {
    await disconnect(sessionId);
  } catch (e) {
    toastError("Could not disconnect", toIpcError(e).message);
    return;
  }
  const { panes, close } = usePaneStore.getState();
  const target = panes.remote.target;
  if (target?.kind === "remote" && target.sessionId === sessionId) {
    close("remote");
  }
}
