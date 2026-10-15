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
});
