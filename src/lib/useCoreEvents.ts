/**
 * Subscribes once (from `App`) to the backend's events and feeds them into
 * the stores: profile changes re-pull the list, host key prompts and
 * transfer conflicts join the prompt queue, session states update
 * `sessionStore`, transfer events update `transferStore`, and settings
 * changes re-pull `backendSettingsStore`, and remote edit reports its saves
 * (a toast per upload or failure; a conflict joins the prompt queue), and a
 * finished sync toasts and re-lists its tab's panes. Also
 * does the initial profile and
 * transfer load, and turns restored tabs of deleted profiles into blank ones.
 *
 * The automatic reconnect is announced here: a session going from
 * `reconnecting` to `connected` toasts and re-lists its tab's panes; one
 * going from `reconnecting` to `disconnected` (the core gave up, or needs a
 * prompt) toasts why. A manual Retry reports its own outcome (`connect.ts`).
 */

import { useEffect } from "react";

import {
  onBatchCounting,
  onDragOutProgress,
  onEditConflict,
  onEditFailed,
  onEditUploaded,
  onHostKeyPrompt,
  onProfilesChanged,
  onSessionStateChanged,
  onSettingsChanged,
  onSyncFinished,
  onTransferConflict,
  onTransferJobChanged,
  onTransferProgress,
  onTransfersUpdated,
} from "../ipc/events";
import type { SessionStateChangedEvent } from "../ipc/types";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { useProfilesStore } from "../state/profilesStore";
import { usePromptStore } from "../state/promptStore";
import { useSessionStore } from "../state/sessionStore";
import { syncFinished } from "../state/syncStore";
import { useTabsStore } from "../state/tabsStore";
import { toastError, toastSuccess } from "../state/toastStore";
import { useTransferStore } from "../state/transferStore";
import { dragOutProgress } from "./dragOut";
import { editFailed, editUploaded } from "./edit";
import { refreshSessionPanes } from "./tabs";

function onSessionState(event: SessionStateChangedEvent) {
  const previous = useSessionStore.getState().apply(event);
  const { state, sessionId } = event;
  // The backend gave up waiting (timeout) or the connect died: a pending
  // host key question for it can no longer be answered.
  if (state.status === "disconnected") {
    usePromptStore.getState().dropSession(sessionId);
    // A user disconnect closed the session's edits in the backend.
    if (state.reason === null) {
      usePromptStore.getState().dropEditSession(sessionId);
    }
  }
  if (previous?.status !== "reconnecting") return;
  const name =
    useProfilesStore.getState().profiles.find((p) => p.id === event.profileId)
      ?.name ?? "the server";
  if (state.status === "connected") {
    toastSuccess(`Reconnected to ${name}`);
    refreshSessionPanes(sessionId);
  } else if (state.status === "disconnected") {
    toastError(
      `Could not reconnect to ${name}`,
      state.reason ?? "The connection was closed.",
    );
  }
}

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
      onSessionStateChanged(onSessionState),
      onSettingsChanged(() => {
        // Only worth a re-read once something showed the settings.
        if (useBackendSettingsStore.getState().settings) {
          void useBackendSettingsStore.getState().load();
        }
      }),
      onTransfersUpdated(() => transfers().scheduleResync()),
      onTransferJobChanged(({ job }) => transfers().applyJob(job)),
      onTransferProgress((event) => transfers().applyProgress(event)),
      onBatchCounting((event) => transfers().applyCounting(event)),
      onTransferConflict((event) =>
        usePromptStore.getState().push({ kind: "transferConflict", event }),
      ),
      onEditUploaded(editUploaded),
      onEditFailed(editFailed),
      onEditConflict((event) =>
        usePromptStore.getState().push({ kind: "editConflict", event }),
      ),
      onDragOutProgress(dragOutProgress),
      onSyncFinished(syncFinished),
    ];
    const forgetMissing = (profiles: { id: string }[], loaded: boolean) => {
      if (loaded) {
        useTabsStore
          .getState()
          .forgetMissingProfiles(new Set(profiles.map((p) => p.id)));
      }
    };
    const unsubProfiles = useProfilesStore.subscribe((s) =>
      forgetMissing(s.profiles, s.loaded),
    );
    return () => {
      unsubProfiles();
      for (const sub of subs) {
        sub.then((unlisten) => unlisten()).catch(() => undefined);
      }
    };
  }, []);
}
