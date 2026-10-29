/**
 * How a session's state reads on a `StatusDot` (the sidebar's connection
 * rows): one place for the wording and tones.
 */

import type { StatusTone } from "../components/StatusDot";
import type { SessionState } from "../ipc/types";

export interface SessionStatusView {
  tone: StatusTone;
  label: string;
  pulse: boolean;
}

export function sessionStatus(
  state: SessionState | undefined,
): SessionStatusView {
  switch (state?.status) {
    case "connecting":
      return { tone: "busy", label: "Connecting…", pulse: true };
    case "connected":
      return { tone: "ok", label: "Connected", pulse: false };
    case "reconnecting":
      return {
        tone: "warning",
        label: `Reconnecting (attempt ${state.attempt} of ${state.maxAttempts})`,
        pulse: true,
      };
    case "disconnected":
      return state.reason
        ? { tone: "error", label: state.reason, pulse: false }
        : { tone: "idle", label: "Not connected", pulse: false };
    default:
      return { tone: "idle", label: "Not connected", pulse: false };
  }
}
