import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusDot } from "./StatusDot";

describe("StatusDot", () => {
  it("exposes its label and tone", () => {
    render(<StatusDot tone="ok" label="Connected" />);
    const dot = screen.getByRole("img", { name: "Connected" });
    expect(dot).toHaveAttribute("data-tone", "ok");
    expect(dot).toHaveAttribute("title", "Connected");
    expect(dot).not.toHaveAttribute("data-pulse");
  });

  it("pulses while in progress", () => {
    render(<StatusDot tone="busy" label="Connecting" pulse />);
    expect(screen.getByRole("img", { name: "Connecting" })).toHaveAttribute(
      "data-pulse",
      "true",
    );
  });
});
