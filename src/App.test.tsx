import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// App wires up IPC on mount; jsdom has no Tauri bridge, so stub it out.
// `invoke` resolves per-command fixtures: list commands return arrays, the rest
// resolve trivially.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(cmd === "note_list" ? [] : undefined),
  ),
}));

import App from "./App";

describe("App", () => {
  it("renders the shell with the brand and the empty notes state", async () => {
    render(<App />);

    expect(screen.getByText("Iris")).toBeInTheDocument();
    expect(screen.getByText("Greet (pure core command)")).toBeInTheDocument();
    expect(await screen.findByText("No notes yet.")).toBeInTheDocument();
  });

  it("exposes the greet and add-note affordances", () => {
    render(<App />);

    expect(screen.getByLabelText("Your name")).toBeInTheDocument();
    expect(screen.getByLabelText("Add a note")).toBeInTheDocument();
  });
});
