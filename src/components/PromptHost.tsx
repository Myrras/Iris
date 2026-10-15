/**
 * Renders the head of the prompt queue: host key questions, password and
 * passphrase prompts, and the changed-host-key warning — one at a time.
 */

import { usePromptStore } from "../state/promptStore";
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
    </>
  );
}
