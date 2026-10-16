import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Breadcrumb } from "./Breadcrumb";

describe("Breadcrumb", () => {
  it("shows every segment with the current folder last", () => {
    render(<Breadcrumb path="/home/alice/projects" onNavigate={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Path" });
    expect(nav).toHaveTextContent("/homealiceprojects");
    expect(screen.getByText("projects")).toHaveAttribute(
      "aria-current",
      "location",
    );
    // The current folder is not a link to itself.
    expect(screen.queryByRole("button", { name: "projects" })).toBeNull();
  });

  it("navigates to a clicked ancestor", () => {
    const onNavigate = vi.fn();
    render(<Breadcrumb path="/home/alice/projects" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "home" }));
    expect(onNavigate).toHaveBeenCalledWith("/home");
    fireEvent.click(screen.getByRole("button", { name: "/" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/");
  });

  it("asks to edit on a click on the empty bar or a double-click, not on a segment", () => {
    const onNavigate = vi.fn();
    const onEdit = vi.fn();
    render(
      <Breadcrumb path="/home/alice" onNavigate={onNavigate} onEdit={onEdit} />,
    );
    const nav = screen.getByRole("navigation", { name: "Path" });
    fireEvent.click(screen.getByRole("button", { name: "home" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "home" }));
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.click(nav);
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(screen.getByText("alice"));
    expect(onEdit).toHaveBeenCalledTimes(2);
  });
});
