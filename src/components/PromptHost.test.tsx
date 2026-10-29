import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  answerHostKey: vi.fn(() => Promise.resolve()),
}));

import type { ConnectionProfile } from "../ipc/types";
import { usePromptStore } from "../state/promptStore";
import { PromptHost } from "./PromptHost";

const profile: ConnectionProfile = {
  id: "p-1",
  name: "Alpha",
  host: "alpha.example.test",
  port: 22,
  user: "alice",
  auth: { kind: "password" },
  startDir: null,
  jump: null,
  favorites: [],
};

beforeEach(() => {
  usePromptStore.setState({ queue: [] });
});

describe("PromptHost", () => {
  it("keeps one set of footer buttons on screen while a host key question jumps in front of a busy password prompt", () => {
    vi.useFakeTimers();
    // The attempt never settles: the prompt stays busy ("Connecting…").
    usePromptStore.getState().push({
      kind: "secret",
      secret: "password",
      profile,
      attempt: () => new Promise<void>(() => {}),
      onCancel: () => {},
    });
    render(<PromptHost />);
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "example-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();

    act(() => {
      usePromptStore.getState().push({
        kind: "hostKey",
        event: {
          type: "hostKeyPrompt",
          requestId: "r-1",
          sessionId: "s-1",
          host: "alpha.example.test",
          port: 22,
          keyType: "ssh-ed25519",
          fingerprintSha256: "SHA256:AAAAexamplefingerprintBBBB",
        },
      });
    });

    // Right away, before any exit animation ends: the question owns the
    // screen, the busy prompt is hidden (not painted under it).
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      screen.getByRole("dialog", { name: "Unknown host key" }),
    ).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Connecting…" })).toBeNull();

    act(() => {
      vi.runAllTimers();
    });
    expect(document.querySelectorAll("footer")).toHaveLength(1);
    vi.useRealTimers();
  });
});
