import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  resolveEdit: vi.fn(() => Promise.resolve()),
}));
vi.mock("../state/toastStore", () => ({ toastError: vi.fn() }));

import { resolveEdit } from "../ipc/commands";
import type { EditConflictEvent } from "../ipc/types";
import { usePromptStore } from "../state/promptStore";
import { toastError } from "../state/toastStore";
import { PromptHost } from "./PromptHost";

function conflict(
  editId: string,
  remote: EditConflictEvent["remote"] = { size: 2048, mtime: 1_700_000_500 },
): EditConflictEvent {
  return {
    type: "editConflict",
    editId,
    sessionId: "s-1",
    path: `/srv/www/${editId}.html`,
    remote,
    baseline: { size: 1024, mtime: 1_700_000_000 },
  };
}

function push(event: EditConflictEvent) {
  usePromptStore.getState().push({ kind: "editConflict", event });
}

const dialog = () =>
  screen.getByRole("dialog", { name: "File changed on the server" });

beforeEach(() => {
  vi.clearAllMocks();
  usePromptStore.setState({ queue: [] });
});

describe("EditConflictDialog", () => {
  it("explains the change and compares the opened and current server copy", () => {
    push(conflict("index"));
    render(<PromptHost />);

    expect(dialog()).toHaveTextContent(
      "index.html in /srv/www was changed on the server since you opened it.",
    );
    expect(dialog()).toHaveTextContent("When opened");
    expect(dialog()).toHaveTextContent("1.0 KB");
    expect(dialog()).toHaveTextContent("Server now");
    expect(dialog()).toHaveTextContent("2.0 KB");
    expect(dialog()).toHaveTextContent("index (edited).html");
  });

  it("sends each answer and moves on to the next conflict", async () => {
    push(conflict("a"));
    push(conflict("b"));
    push(conflict("c"));
    render(<PromptHost />);

    fireEvent.click(screen.getByRole("button", { name: "Overwrite server" }));
    await waitFor(() =>
      expect(resolveEdit).toHaveBeenCalledWith("a", "overwrite"),
    );
    await waitFor(() => expect(dialog()).toHaveTextContent("b.html"));
    fireEvent.click(screen.getByRole("button", { name: "Discard my changes" }));
    await waitFor(() =>
      expect(resolveEdit).toHaveBeenCalledWith("b", "discard"),
    );
    await waitFor(() => expect(dialog()).toHaveTextContent("c.html"));
    fireEvent.click(screen.getByRole("button", { name: "Save as copy" }));
    await waitFor(() =>
      expect(resolveEdit).toHaveBeenCalledWith("c", "saveCopy"),
    );
    await waitFor(() => expect(usePromptStore.getState().queue).toEqual([]));
  });

  it("saves a copy when closed", async () => {
    push(conflict("a"));
    render(<PromptHost />);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(resolveEdit).toHaveBeenCalledWith("a", "saveCopy"),
    );
  });

  it("says when the server copy was deleted and cannot discard then", () => {
    push(conflict("gone", null));
    render(<PromptHost />);
    expect(dialog()).toHaveTextContent("was deleted on the server");
    expect(dialog()).toHaveTextContent("Deleted");
    expect(
      screen.getByRole("button", { name: "Discard my changes" }),
    ).toBeDisabled();
  });

  it("reports an answer the backend refused and closes", async () => {
    vi.mocked(resolveEdit).mockRejectedValueOnce({
      kind: "notFound",
      message: "not found: edit",
    });
    push(conflict("a"));
    render(<PromptHost />);
    fireEvent.click(screen.getByRole("button", { name: "Overwrite server" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not answer the conflict",
        "not found: edit",
      ),
    );
    await waitFor(() => expect(usePromptStore.getState().queue).toEqual([]));
  });
});
