import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
};

beforeEach(() => {
  usePromptStore.setState({ queue: [] });
});

function ask(
  attempt: (value: string, remember: boolean) => Promise<void>,
  secret: "password" | "passphrase" = "password",
  extra: { notice?: string; rememberByDefault?: boolean } = {},
) {
  const onCancel = vi.fn();
  usePromptStore
    .getState()
    .push({ kind: "secret", secret, profile, attempt, onCancel, ...extra });
  render(<PromptHost />);
  return { onCancel };
}

describe("SecretPrompt", () => {
  it("asks for the password of user@host", () => {
    ask(vi.fn());
    const dialog = screen.getByRole("dialog", { name: "Password required" });
    expect(dialog).toHaveTextContent("alice@alpha.example.test");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("asks for a key passphrase", () => {
    ask(vi.fn(), "passphrase");
    expect(
      screen.getByRole("dialog", { name: "Passphrase required" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Key passphrase")).toBeInTheDocument();
  });

  it("hands the value to attempt, clears it and closes on success", async () => {
    const attempt = vi.fn(() => Promise.resolve());
    ask(attempt);
    const input = screen.getByLabelText("Password");
    fireEvent.change(input, { target: { value: "example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(attempt).toHaveBeenCalledWith("example-password", false);
    expect(input).toHaveValue("");
    await waitFor(() => expect(usePromptStore.getState().queue).toEqual([]));
  });

  it("passes the remember-in-keychain choice", () => {
    const attempt = vi.fn(() => Promise.resolve());
    ask(attempt);
    const remember = screen.getByRole("checkbox", {
      name: /Remember in keychain/,
    });
    expect(remember).not.toBeChecked();
    fireEvent.click(remember);
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "example-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(attempt).toHaveBeenCalledWith("example-password", true);
  });

  it("shows why it asks again and starts with remember ticked", () => {
    ask(vi.fn(), "password", {
      notice: "The saved password was not accepted.",
      rememberByDefault: true,
    });
    expect(
      screen.getByText("The saved password was not accepted."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /Remember in keychain/ }),
    ).toBeChecked();
  });

  it("stays open with the error when the password is wrong", async () => {
    const attempt = vi.fn(() =>
      Promise.reject({ kind: "authFailed", message: "authentication failed" }),
    );
    ask(attempt);
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong" },
    });
    fireEvent.submit(screen.getByLabelText("Password").closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "authentication failed",
    );
    expect(usePromptStore.getState().queue).toHaveLength(1);
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("cancels", () => {
    const { onCancel } = ask(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(usePromptStore.getState().queue).toEqual([]);
  });
});
