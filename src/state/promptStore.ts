/**
 * Queue of blocking prompts: from the connect flow an unknown host key, a
 * password or key passphrase and the changed-host-key warning; from the
 * transfer engine a file that already exists at the destination. The head of
 * the queue is the one on screen (`PromptHost`); the rest wait their turn.
 *
 * SECURITY: a secret prompt never holds the typed value — the prompt
 * component keeps it in local state and hands it straight to `attempt`.
 */

import { create } from "zustand";

import type {
  ConnectionProfile,
  BatchId,
  HostKeyPromptEvent,
  SessionId,
  TransferConflictEvent,
  TransferId,
} from "../ipc/types";

export type SecretKind = "password" | "passphrase";

export type PromptRequest =
  | {
      /** Unknown host key: the connect waits for `answerHostKey`. */
      kind: "hostKey";
      event: HostKeyPromptEvent;
    }
  | {
      /** Password or key passphrase for one connect. */
      kind: "secret";
      secret: SecretKind;
      profile: ConnectionProfile;
      /**
       * Why it asks although a secret may be saved (e.g. the saved password
       * was not accepted); shown above the field.
       */
      notice?: string;
      /** Whether "Remember in keychain" starts ticked. */
      rememberByDefault?: boolean;
      /**
       * Connect with `value` (stored in the keychain afterwards when
       * `remember`). Resolves when the prompt may close; rejects with an
       * `IpcError` to keep it open and show the message.
       */
      attempt: (value: string, remember: boolean) => Promise<void>;
      /** The user dismissed the prompt without connecting. */
      onCancel: () => void;
    }
  | {
      /** The server's key differs from `known_hosts`: a blocking warning. */
      kind: "hostKeyChanged";
      profileName: string;
      message: string;
    }
  | {
      /** A transfer's destination exists: the job waits for `resolveConflict`. */
      kind: "transferConflict";
      event: TransferConflictEvent;
    };

export type Prompt = PromptRequest & { id: number };

interface PromptState {
  queue: Prompt[];
  /** Enqueue a prompt and return its id. */
  push: (request: PromptRequest) => number;
  /** Remove a prompt (answered, cancelled or no longer relevant). */
  resolve: (id: number) => void;
  /** A session ended: its pending host key prompt is moot (backend timeout). */
  dropSession: (sessionId: SessionId) => void;
  /**
   * Drop the waiting conflicts of a batch: an apply-to-all answer decides
   * them in the backend, without new events.
   */
  dropTransferBatch: (batchId: BatchId) => void;
  /** A job no longer waits for an answer (cancelled, decided elsewhere). */
  dropTransferJob: (jobId: TransferId) => void;
}

let seq = 0;

export const usePromptStore = create<PromptState>((set) => ({
  queue: [],
  push: (request) => {
    seq += 1;
    const prompt = { ...request, id: seq } as Prompt;
    set((s) => {
      if (prompt.kind !== "hostKey") return { queue: [...s.queue, prompt] };
      // A host key prompt blocks a connect that may have been started from a
      // password prompt still sitting at the head (busy) — so it jumps ahead
      // of every non-host-key prompt, or both would wait on each other.
      const firstOther = s.queue.findIndex((p) => p.kind !== "hostKey");
      const at = firstOther === -1 ? s.queue.length : firstOther;
      return {
        queue: [...s.queue.slice(0, at), prompt, ...s.queue.slice(at)],
      };
    });
    return seq;
  },
  resolve: (id) => set((s) => ({ queue: s.queue.filter((p) => p.id !== id) })),
  dropSession: (sessionId) =>
    set((s) => ({
      queue: s.queue.filter(
        (p) => p.kind !== "hostKey" || p.event.sessionId !== sessionId,
      ),
    })),
  dropTransferBatch: (batchId) =>
    set((s) => ({
      queue: s.queue.filter(
        (p) => p.kind !== "transferConflict" || p.event.batchId !== batchId,
      ),
    })),
  dropTransferJob: (jobId) =>
    set((s) =>
      s.queue.some(
        (p) => p.kind === "transferConflict" && p.event.jobId === jobId,
      )
        ? {
            queue: s.queue.filter(
              (p) => p.kind !== "transferConflict" || p.event.jobId !== jobId,
            ),
          }
        : s,
    ),
}));
