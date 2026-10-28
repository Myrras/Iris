import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Entry } from "../ipc/types";
import { ChmodDialog } from "./ChmodDialog";

function entry(name: string, extra: Partial<Entry> = {}): Entry {
  return {
    name,
    path: `/srv/${name}`,
    kind: { type: "file" },
    size: 1024,
    mtime: null,
    mode: 0o100644,
    hidden: false,
    ...extra,
  };
}

function open(entries: Entry[]) {
  const onApply = vi.fn();
  render(
    <ChmodDialog request={{ entries }} onApply={onApply} onClose={vi.fn()} />,
  );
  return onApply;
}

const octal = () => screen.getByLabelText<HTMLInputElement>("Octal");
const box = (label: string) => screen.getByLabelText<HTMLInputElement>(label);

describe("ChmodDialog", () => {
  it("shows the current mode in the grid and as octal", () => {
    open([entry("app.conf")]);
    expect(screen.getByText("rw-r--r-- (644)")).toBeInTheDocument();
    expect(octal().value).toBe("644");
    expect(box("Owner read").checked).toBe(true);
    expect(box("Owner write").checked).toBe(true);
    expect(box("Owner execute").checked).toBe(false);
    expect(box("Others read").checked).toBe(true);
    expect(box("Others write").checked).toBe(false);
  });

  it("keeps the grid and the octal field in step", () => {
    open([entry("run.sh")]);
    fireEvent.click(box("Owner execute"));
    expect(octal().value).toBe("744");
    fireEvent.change(octal(), { target: { value: "750" } });
    expect(box("Group execute").checked).toBe(true);
    expect(box("Others read").checked).toBe(false);
  });

  it("validates the octal field", () => {
    const onApply = open([entry("run.sh")]);
    fireEvent.change(octal(), { target: { value: "79" } });
    expect(screen.getByRole("alert")).toHaveTextContent("octal digits");
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    fireEvent.submit(octal().form!);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(octal(), { target: { value: "0755" } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith(0o755, false);
  });

  it("offers recursion only for folders", () => {
    const onApply = open([
      entry("site", { kind: { type: "dir" }, mode: 0o40755 }),
    ]);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Apply to everything inside/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith(0o755, true);
  });

  it("has no recursion for files and reports mixed modes", () => {
    open([entry("a"), entry("b", { mode: 0o100600 })]);
    expect(
      screen.queryByRole("checkbox", { name: /Apply to everything inside/ }),
    ).toBeNull();
    expect(screen.getByText(/Current:/)).toHaveTextContent("mixed");
  });

  it("has nothing to edit when no mode is known", () => {
    open([entry("C-drive-file.txt", { mode: null })]);
    expect(screen.getByText(/not available here/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Octal")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
