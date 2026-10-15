/**
 * Subscribes once (from `App`) to the backend's events and feeds them into
 * the stores: profile changes re-pull the list, host key prompts and
 * transfer conflicts join the prompt queue, session states update
 * `sessionStore`, transfer events update `transferStore`, and settings
 * changes re-pull `backendSettingsStore`. Also does the initial profile and
 * transfer load.
 */

import { useEffect } from "react";

import {
  onHostKeyPrompt,
  onProfilesChanged,
  onSessionStateChanged,
  onSettingsChanged,
  onTransferConflict,
  onTransferJobChanged,
  onTransferProgress,
  onTransfersUpdated,
} from "../ipc/events";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { useProfilesStore } from "../state/profilesStore";
import { usePromptStore } from "../state/promptStore";
import { useSessionStore } from "../state/sessionStore";
import { useTransferStore } from "../state/transferStore";

export function useCoreEvents(): void {
  useEffect(() => {
    void useProfilesStore.getState().refresh();
    void useTransferStore.getState().resync();

    const transfers = useTransferStore.getState;
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
      onSettingsChanged(() => {
        // Only worth a re-read once something showed the settings.
        if (useBackendSettingsStore.getState().settings) {
          void useBackendSettingsStore.getState().load();
        }
      }),
      onTransfersUpdated(() => transfers().scheduleResync()),
      onTransferJobChanged(({ job }) => transfers().applyJob(job)),
      onTransferProgress((event) => transfers().applyProgress(event)),
      onTransferConflict((event) =>
        usePromptStore.getState().push({ kind: "transferConflict", event }),
      ),
    ];
    return () => {
      for (const sub of subs) {
        sub.then((unlisten) => unlisten()).catch(() => undefined);
      }
    };
  }, []);
}
