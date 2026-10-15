/**
 * Subscribes once (from `App`) to the backend's connection events and feeds
 * them into the stores: profile changes re-pull the list, host key prompts
 * join the prompt queue, session states update `sessionStore`. Also does the
 * initial profile load.
 */

import { useEffect } from "react";

import {
  onHostKeyPrompt,
  onProfilesChanged,
  onSessionStateChanged,
} from "../ipc/events";
import { useProfilesStore } from "../state/profilesStore";
import { usePromptStore } from "../state/promptStore";
import { useSessionStore } from "../state/sessionStore";

export function useCoreEvents(): void {
  useEffect(() => {
    void useProfilesStore.getState().refresh();

    const subs = [
      onProfilesChanged(() => void useProfilesStore.getState().refresh()),
      onHostKeyPrompt((event) =>
        usePromptStore.getState().push({ kind: "hostKey", event }),
      ),
      onSessionStateChanged((event) => {
        useSessionStore.getState().apply(event);
        // The backend gave up waiting (timeout) or the connect died: a
        // pending host key question for it can no longer be answered.
        if (event.state === "disconnected") {
          usePromptStore.getState().dropSession(event.sessionId);
        }
      }),
    ];
    return () => {
      for (const sub of subs) {
        sub.then((unlisten) => unlisten()).catch(() => undefined);
      }
    };
  }, []);
}
