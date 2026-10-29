/**
 * The connect and reconnect flows every entry point uses (sidebar row,
 * Connect / Reconnect / Retry buttons), modelled on Selene's
 * `lib/connect.ts`: try, ask for what the backend says is missing, try
 * again with it.
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
 * One session per connection: clicking a connection in the sidebar
 * (`openConnection`) shows the one it has, and only connects when it has
 * none. A connect hands the session to the connection even if the user
 * switched to another one meanwhile (it stays in the background). A manual
 * reconnect ("Retry") revives the SAME session id, so the connection's tabs
 * and its paused transfers need no remapping.
 *
 * SECURITY: secrets pass from the prompt's local state straight into
 * `connect` / `reconnect`; nothing here keeps or logs them.
 */

import {
  clearSecret,
  connect,
  disconnect,
  reconnect,
  toIpcError,
  type ConnectSecrets,
} from "../ipc/commands";
import type { ConnectionProfile, IpcError, SessionId } from "../ipc/types";
import { useProfilesStore } from "../state/profilesStore";
import { usePromptStore, type SecretKind } from "../state/promptStore";
import { useSessionStore } from "../state/sessionStore";
import { useTabsStore } from "../state/tabsStore";
import { toastError, toastSuccess } from "../state/toastStore";
import { refreshSessionPanes, requestDisconnectSession } from "./connections";

/** Errors a retyped secret can fix: the prompt stays open for them. */
const RETRYABLE: Record<SecretKind, ReadonlySet<string>> = {
  password: new Set(["authFailed", "passwordRequired"]),
  passphrase: new Set(["passphraseRequired", "keyFile", "authFailed"]),
};

/** Profiles and sessions with a connect in progress (no double connects). */
const inFlight = new Set<string>();

function report(profile: ConnectionProfile, err: IpcError, verb: string) {
  if (err.kind === "hostKeyRejected") return; // the user said no
  if (err.kind === "hostKeyChanged") {
    usePromptStore.getState().push({
      kind: "hostKeyChanged",
      profileName: profile.name,
      message: err.message,
    });
    return;
  }
  toastError(`Could not ${verb} ${profile.name}`, err.message);
}

const isWrongPassphrase = (err: IpcError) =>
  err.kind === "keyFile" && err.message.endsWith("wrong passphrase");

/**
 * The secret to ask for after an attempt without one failed with `err`, and
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

/**
 * Run `attempt` without secrets, then — when the backend asks for one —
 * with what the user types. Resolves with its result, or `null` when
 * cancelled or failed (already reported, worded with `verb`).
 */
async function withSecrets<T>(
  profile: ConnectionProfile,
  verb: string,
  attempt: (secrets?: ConnectSecrets) => Promise<T>,
): Promise<T | null> {
  try {
    return await attempt();
  } catch (e) {
    const err = toIpcError(e);
    const ask = secretFor(profile, err);
    if (!ask) {
      report(profile, err, verb);
      return null;
    }
    const { secret, stale } = ask;
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
            const result = await attempt({
              ...(secret === "password"
                ? { password: value }
                : { passphrase: value }),
              remember,
            });
            // A refused saved secret the user chose not to keep is dropped.
            if (stale && !remember) {
              void clearSecret(profile.id, secret).catch(() => undefined);
            }
            resolve(result);
          } catch (e2) {
            const err2 = toIpcError(e2);
            // Rejecting keeps the prompt open with the message.
            if (RETRYABLE[secret].has(err2.kind)) throw err2;
            report(profile, err2, verb);
            resolve(null);
          }
        },
        onCancel: () => resolve(null),
      });
    });
  }
}

/**
 * Connect `profile`'s connection (created when there is none; the active
 * connection stays as it is) and reopen its remote tabs' folders on the new
 * session, the profile's start folder for a tab that never had one.
 * Resolves with the session id: the one it already has, or `null` when
 * cancelled, failed (already reported) or a connect is already running.
 */
export async function connectProfile(
  profile: ConnectionProfile,
): Promise<SessionId | null> {
  const existing = useTabsStore.getState().connections[profile.id];
  if (existing?.sessionId) return existing.sessionId;
  if (inFlight.has(profile.id)) return null;
  inFlight.add(profile.id);
  useTabsStore.getState().ensureConnection(profile.id);
  useTabsStore.getState().setConnecting(profile.id, true);
  try {
    const sessionId = await withSecrets(profile, "connect to", (secrets) =>
      secrets ? connect(profile.id, secrets) : connect(profile.id),
    );
    if (sessionId === null) return null;
    if (!useTabsStore.getState().connections[profile.id]) {
      // The profile was deleted while connecting: nothing would show it.
      void disconnect(sessionId).catch(() => undefined);
      return null;
    }
    useTabsStore
      .getState()
      .attachSession(profile.id, sessionId, profile.startDir);
    return sessionId;
  } finally {
    inFlight.delete(profile.id);
    useTabsStore.getState().setConnecting(profile.id, false);
  }
}

/**
 * The sidebar's click: make `profile`'s connection the one the Remote pane
 * shows. One with a session (whatever its state) is just shown; one without
 * (new, or disconnected by the user) connects too. A brand-new connection
 * that does not come up (cancelled, failed) leaves no trace: the Remote pane
 * goes back to the connection it showed before.
 */
export async function openConnection(
  profile: ConnectionProfile,
): Promise<void> {
  const tabs = useTabsStore.getState();
  const previous = tabs.activeProfileId;
  const fresh = !tabs.connections[profile.id];
  tabs.activate(profile.id);
  const conn = useTabsStore.getState().connections[profile.id];
  if (!conn || conn.sessionId || conn.connecting) return;
  if ((await connectProfile(profile)) !== null || !fresh) return;
  const now = useTabsStore.getState();
  if (now.connections[profile.id]?.sessionId !== null) return;
  if (now.activeProfileId === profile.id) {
    now.activate(previous && now.connections[previous] ? previous : null);
  }
  useTabsStore.getState().dropConnection(profile.id);
}

/**
 * Reconnect a dropped session under its own id ("Retry", "Retry now"),
 * asking for a secret when the backend needs one. On success its panes are
 * re-listed (and its paused transfers resume in the backend). Resolves
 * `true` when connected again.
 */
export async function retrySession(sessionId: SessionId): Promise<boolean> {
  const info = useSessionStore.getState().sessions[sessionId];
  const profile = useProfilesStore
    .getState()
    .profiles.find((p) => p.id === info?.profileId);
  if (!info || !profile || inFlight.has(sessionId)) return false;
  inFlight.add(sessionId);
  try {
    const done = await withSecrets(profile, "reconnect to", async (secrets) => {
      await (secrets ? reconnect(sessionId, secrets) : reconnect(sessionId));
      return true;
    });
    if (!done) return false;
    toastSuccess(`Reconnected to ${profile.name}`);
    refreshSessionPanes(sessionId);
    return true;
  } finally {
    inFlight.delete(sessionId);
  }
}

/**
 * Close a session at the user's request (asking first when it still has
 * transfers). Its connection and tabs stay, with Reconnect.
 */
export function disconnectSession(sessionId: SessionId): void {
  requestDisconnectSession(sessionId);
}
