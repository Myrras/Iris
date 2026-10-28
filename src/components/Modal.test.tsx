import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders outside its parent so clipped ancestors can't cut it off", () => {
    const { container } = render(
      <div style={{ overflow: "hidden" }}>
        <Modal open title="Hello" onClose={() => {}}>
          body
        </Modal>
      </div>,
    );
    const dialog = screen.getByRole("dialog", { name: "Hello" });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("closes on Escape, the close button and a backdrop click", () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Hello" onClose={onClose}>
        body
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.mouseDown(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("ignores clicks inside the card", () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Hello" onClose={onClose}>
        body
      </Modal>,
    );

    fireEvent.mouseDown(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    render(
      <Modal open={false} title="Hello" onClose={() => {}}>
        body
      </Modal>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("with more than one open", () => {
    /** A footer like the busy dialogs': Cancel plus a wider primary action. */
    function Pair() {
      return (
        <>
          <Modal
            open
            title="First"
            onClose={() => {}}
            footer={
              <>
                <button type="button">Cancel</button>
                <button type="button">Connecting…</button>
              </>
            }
          >
            one
          </Modal>
          <Modal
            open
            title="Second"
            onClose={() => {}}
            footer={
              <>
                <button type="button">Cancel</button>
                <button type="button">Trust</button>
              </>
            }
          >
            two
          </Modal>
        </>
      );
    }

    it("shows one set of footer buttons: the newest dialog's", () => {
      render(<Pair />);
      // Both stay mounted (the covered one keeps its state) ...
      expect(document.querySelectorAll("footer")).toHaveLength(2);
      // ... but only the newest is shown and reachable.
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.getByRole("dialog", { name: "Second" })).toBeVisible();
      expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Connecting…" })).toBeNull();
      const covered = document.querySelectorAll('[data-covered="true"]');
      expect(covered).toHaveLength(1);
      expect(covered[0]).toHaveAttribute("aria-hidden", "true");
      expect(covered[0]).toContainElement(screen.getByText("one"));
    });

    it("hides a dialog that is still animating out while another opens", () => {
      vi.useFakeTimers();
      const { rerender } = render(
        <Modal open title="First" onClose={() => {}}>
          one
        </Modal>,
      );
      // First starts closing (its exit animation keeps it mounted) while a
      // second one opens: the two must not cross-fade on top of each other.
      rerender(
        <>
          <Modal open={false} title="First" onClose={() => {}}>
            one
          </Modal>
          <Modal open title="Second" onClose={() => {}}>
            two
          </Modal>
        </>,
      );
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.getByRole("dialog", { name: "Second" })).toBeVisible();
      act(() => {
        vi.runAllTimers();
      });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      vi.useRealTimers();
    });

    it("lets Escape close only the dialog on top", () => {
      const underneath = vi.fn();
      const onTop = vi.fn();
      render(
        <>
          <Modal open title="First" onClose={underneath}>
            one
          </Modal>
          <Modal open title="Second" onClose={onTop}>
            two
          </Modal>
        </>,
      );
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onTop).toHaveBeenCalledTimes(1);
      expect(underneath).not.toHaveBeenCalled();
    });

    it("gives the screen back to the first dialog when the second closes", () => {
      vi.useFakeTimers();
      const first = (
        <Modal open title="First" onClose={() => {}}>
          one
        </Modal>
      );
      const { rerender } = render(
        <>
          {first}
          <Modal open title="Second" onClose={() => {}}>
            two
          </Modal>
        </>,
      );
      expect(screen.queryByRole("dialog", { name: "First" })).toBeNull();
      rerender(
        <>
          {first}
          <Modal open={false} title="Second" onClose={() => {}}>
            two
          </Modal>
        </>,
      );
      expect(screen.getByRole("dialog", { name: "First" })).toBeVisible();
      act(() => {
        vi.runAllTimers();
      });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      vi.useRealTimers();
    });
  });
});
