import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WelcomeScreen } from "./WelcomeScreen";

describe("WelcomeScreen", () => {
  it("greets and points at connecting to a server", () => {
    render(<WelcomeScreen />);

    expect(screen.getByText("Welcome to Iris")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect to a server…" }),
    ).toBeInTheDocument();
  });

  it("disables the connect button until there is a connect flow", () => {
    render(<WelcomeScreen />);

    expect(
      screen.getByRole("button", { name: "Connect to a server…" }),
    ).toBeDisabled();
  });

  it("starts the connect flow on click", () => {
    const onConnect = vi.fn();
    render(<WelcomeScreen onConnect={onConnect} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Connect to a server…" }),
    );
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
