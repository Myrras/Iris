import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useLayoutStore } from "../state/layoutStore";
import { TransferPanel } from "./TransferPanel";

describe("TransferPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    useLayoutStore.setState({ transfersCollapsed: false });
  });

  it("shows the empty queue placeholder", () => {
    render(<TransferPanel />);

    expect(screen.getByText("No transfers yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transfers" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("collapses and remembers it", () => {
    render(<TransferPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Transfers" }));
    expect(screen.getByRole("button", { name: "Transfers" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(useLayoutStore.getState().transfersCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem("iris.layout") ?? "{}")).toEqual(
      expect.objectContaining({ transfersCollapsed: true }),
    );
  });
});
