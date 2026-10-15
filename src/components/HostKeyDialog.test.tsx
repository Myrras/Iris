import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  answerHostKey: vi.fn(() => Promise.resolve()),
}));
vi.mock("../state/toastStore", () => ({ toastError: vi.fn() }));

import { answerHostKey } from "../ipc/commands";
import { usePromptStore } from "../state/promptStore";
import { toastError } from "../state/toastStore";
import { PromptHost } from "./PromptHost";

const event = {
  type: "hostKeyPrompt" as const,
  requestId: "r-1",
  sessionId: "s-1",
  host: "alpha.example.test",
  port: 2222,
  keyType: "ssh-ed25519",
  fingerprintSha256: "SHA256:AAAAexamplefingerprintBBBB",
};

beforeEach(() => {
  usePromptStore.setState({ queue: [] });
});

function showUnknownKey() {
  usePromptStore.getState().push({ kind: "hostKey", event });
  render(<PromptHost />);
  return screen.getByRole("dialog", { name: "Unknown host key" });
}

describe("HostKeyDialog", () => {
  it("shows host, port, key type and fingerprint", () => {
    const dialog = showUnknownKey();
    expect(dialog).toHaveTextContent("alpha.example.test:2222");
    expect(dialog).toHaveTextContent("ssh-ed25519");
    expect(dialog).toHaveTextContent("SHA256:AAAAexamplefingerprintBBBB");
  });

  it("trusts the key and closes", async () => {
    showUnknownKey();
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() => expect(usePromptStore.getState().queue).toEqual([]));
    expect(answerHostKey).toHaveBeenCalledWith("r-1", true);
  });

  it("rejects the key on Cancel", async () => {
    showUnknownKey();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(usePromptStore.getState().queue).toEqual([]));
    expect(answerHostKey).toHaveBeenCalledWith("r-1", false);
  });

  it("closes with a toast when the answer comes too late", async () => {
    vi.mocked(answerHostKey).mockRejectedValueOnce({
      kind: "notFound",
      message: "no such host key prompt",
    });
    showUnknownKey();
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() => expect(usePromptStore.getState().queue).toEqual([]));
    expect(toastError).toHaveBeenCalledWith(
      "Could not answer the host key prompt",
      "no such host key prompt",
    );
  });

  it("closes when the session's prompt is dropped (timeout)", async () => {
    showUnknownKey();
    usePromptStore.getState().dropSession("s-1");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Unknown host key" }),
      ).toBeNull(),
    );
    expect(answerHostKey).not.toHaveBeenCalled();
  });
});

describe("HostKeyChangedDialog", () => {
  it("warns without a way to connect anyway", async () => {
    usePromptStore.getState().push({
      kind: "hostKeyChanged",
      profileName: "Alpha",
      message: "host key for alpha.example.test changed",
    });
    render(<PromptHost />);
    const dialog = screen.getByRole("dialog", { name: "Host key changed" });
    expect(dialog).toHaveTextContent("Alpha");
    expect(dialog).toHaveTextContent("host key for alpha.example.test changed");
    expect(screen.queryByRole("button", { name: /connect|trust/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(usePromptStore.getState().queue).toEqual([]);
  });
});
