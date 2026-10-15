import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dialog reaches the backend only through the Tauri invoke bridge.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import { invoke } from "@tauri-apps/api/core";

import { useToastStore } from "../state/toastStore";
import { CloseWarningModal } from "./CloseWarningModal";

describe("CloseWarningModal", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
  });

  it("warns that closing interrupts work in progress", () => {
    render(<CloseWarningModal open onClose={() => undefined} />);

    expect(
      screen.getByRole("dialog", { name: "Work still in progress" }),
    ).toBeInTheDocument();
  });

  it("confirms the close via windowConfirmClose", async () => {
    render(<CloseWarningModal open onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("window_confirm_close"),
    );
  });

  it("cancels without closing the app", () => {
    const onClose = vi.fn();
    render(<CloseWarningModal open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("window_confirm_close");
  });

  it("shows a toast and re-enables the button when the close fails", async () => {
    vi.mocked(invoke).mockRejectedValue({ kind: "io", message: "denied" });
    render(<CloseWarningModal open onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.some((t) => t.message === "Could not close Iris"),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Close anyway" })).toBeEnabled();
  });
});
