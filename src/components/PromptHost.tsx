/**
 * Renders the head of the prompt queue: host key questions, password and
 * passphrase prompts, the changed-host-key warning, transfer conflicts and
 * edit conflicts — one at a time.
 */

import { usePromptStore } from "../state/promptStore";
import { ConflictDialog } from "./ConflictDialog";
import { EditConflictDialog } from "./EditConflictDialog";
import { HostKeyChangedDialog, HostKeyDialog } from "./HostKeyDialog";
import { SecretPrompt } from "./SecretPrompt";

export function PromptHost() {
  const head = usePromptStore((s) => s.queue[0]);
  return (
    <>
      <SecretPrompt prompt={head?.kind === "secret" ? head : null} />
      <HostKeyDialog prompt={head?.kind === "hostKey" ? head : null} />
      <HostKeyChangedDialog
        prompt={head?.kind === "hostKeyChanged" ? head : null}
      />
      <ConflictDialog
        prompt={head?.kind === "transferConflict" ? head : null}
      />
      <EditConflictDialog
        prompt={head?.kind === "editConflict" ? head : null}
      />
    </>
  );
}
