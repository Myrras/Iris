import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeleteConfirmModal } from "./DeleteConfirmModal";

describe("DeleteConfirmModal", () => {
  it("says a remote delete is permanent", () => {
    render(
      <DeleteConfirmModal
        request={{ names: ["backup.tar"], remote: true }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete “backup.tar”?");
    expect(dialog).toHaveTextContent("permanently");
    expect(dialog).toHaveTextContent("cannot be undone");
  });

  it("says a local delete goes to the Trash and lists the first names", () => {
    const names = Array.from({ length: 8 }, (_, i) => `file-${i}.txt`);
    render(
      <DeleteConfirmModal
        request={{ names, remote: false }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Move 8 items to the Trash?");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      [
        "file-0.txt",
        "file-1.txt",
        "file-2.txt",
        "file-3.txt",
        "file-4.txt",
        "and 3 more",
      ],
    );
  });

  it("confirms with Enter and cancels with Escape", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <DeleteConfirmModal
        request={{ names: ["a"], remote: true }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter on a focused Cancel to Cancel", () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirmModal
        request={{ names: ["a"], remote: true }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), {
      key: "Enter",
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing without a request", () => {
    render(
      <DeleteConfirmModal
        request={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
