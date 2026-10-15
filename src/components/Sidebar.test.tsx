import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("shows the empty Connections section", () => {
    render(<Sidebar />);

    expect(screen.getByRole("button", { name: "Connections" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("No connections yet.")).toBeInTheDocument();
  });

  it("collapses and expands the Connections section", () => {
    render(<Sidebar />);
    const toggle = screen.getByRole("button", { name: "Connections" });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the new-connection button disabled until connections exist", () => {
    render(<Sidebar />);

    expect(
      screen.getByRole("button", { name: "New connection…" }),
    ).toBeDisabled();
  });
});
