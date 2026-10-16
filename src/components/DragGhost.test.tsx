import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useDragStore } from "../state/dragStore";
import { DragGhost } from "./DragGhost";

beforeEach(() => {
  useDragStore.getState().end();
});

describe("DragGhost", () => {
  it("follows a pane drag and names the action over a target", () => {
    const { container } = render(<DragGhost />);
    expect(container).toBeEmptyDOMElement();

    act(() =>
      useDragStore
        .getState()
        .startPaneDrag({ from: "remote", count: 3, x: 10, y: 20 }),
    );
    expect(screen.getByText("3 items")).toBeInTheDocument();

    act(() =>
      useDragStore
        .getState()
        .movePaneDrag(100, 50, { pane: "local", dir: null }),
    );
    const ghost = screen.getByText("Download 3 items").parentElement;
    expect(ghost).toHaveStyle({ transform: "translate(114px, 60px)" });
    expect(ghost).toHaveAttribute("data-armed", "true");
  });

  it("stays at the window edge outside and shows the download", () => {
    render(<DragGhost />);
    act(() =>
      useDragStore
        .getState()
        .startPaneDrag({ from: "remote", count: 2, x: 10, y: 20 }),
    );
    act(() => useDragStore.getState().movePaneDrag(5000, -40, null, true));
    act(() =>
      useDragStore
        .getState()
        .setPreparing({ bytesDone: 512 * 1024, totalBytes: 2 * 1024 * 1024 }),
    );
    const label = screen.getByText(/^Preparing 2 items… 25% of/);
    const ghost = label.parentElement;
    expect(ghost).toHaveAttribute("data-preparing", "true");
    expect(ghost).toHaveStyle({
      transform: `translate(${window.innerWidth - 228}px, 8px)`,
    });
  });
});
