import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Entry } from "../ipc/types";
import { stubViewport } from "../test/viewport";
import { FileTable } from "./FileTable";

// A 600px-tall viewport: room for ~24 rows, so the window is clearly partial.
stubViewport();

function entry(name: string, extra: Partial<Entry> = {}): Entry {
  return {
    name,
    path: `/srv/${name}`,
    kind: { type: "file" },
    size: 2048,
    mtime: null,
    mode: 0o100644,
    hidden: false,
    ...extra,
  };
}

function renderTable(
  entries: Entry[],
  props: Partial<React.ComponentProps<typeof FileTable>> = {},
) {
  const handlers = {
    onSort: vi.fn(),
    onRowClick: vi.fn(),
    onOpen: vi.fn(),
    onMove: vi.fn(),
    onSelectAll: vi.fn(),
  };
  render(
    <FileTable
      entries={entries}
      sort={{ key: "name", dir: "asc" }}
      selection={new Set()}
      cursor={null}
      label="Test files list"
      emptyText="This folder is empty."
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

/** Data rows (the header row is a `row` too). */
const dataRows = () =>
  screen
    .getAllByRole("row")
    .filter((r) => r.getAttribute("aria-rowindex") !== "1");

describe("FileTable", () => {
  it("virtualises 10,000 rows: only a window is in the DOM", () => {
    const many = Array.from({ length: 10_000 }, (_, i) =>
      entry(`file-${String(i).padStart(5, "0")}.txt`),
    );
    const started = performance.now();
    renderTable(many);
    const elapsed = performance.now() - started;

    const grid = screen.getByRole("grid", { name: "Test files list" });
    expect(grid).toHaveAttribute("aria-rowcount", "10001");
    const rows = dataRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(100);
    expect(screen.getByText("file-00000.txt")).toBeInTheDocument();
    expect(screen.queryByText("file-09999.txt")).toBeNull();
    // Generous bound for slow CI: a non-virtualised render takes seconds.
    expect(elapsed).toBeLessThan(1500);
  });

  it("formats size, permissions and leaves a folder's size blank", () => {
    renderTable([
      entry("docs", { kind: { type: "dir" }, size: 4096, mode: 0o040755 }),
      entry("notes.txt", { size: 1536 }),
    ]);
    const [docs, notes] = dataRows();
    const docCells = within(docs).getAllByRole("gridcell");
    expect(docCells[1]).toHaveTextContent(/^$/);
    expect(docCells[3]).toHaveTextContent("drwxr-xr-x");
    const noteCells = within(notes).getAllByRole("gridcell");
    expect(noteCells[1]).toHaveTextContent("1.5 KB");
    expect(noteCells[3]).toHaveTextContent("-rw-r--r--");
  });

  it("marks a symlink and shows its target as tooltip", () => {
    renderTable([
      entry("current", {
        kind: { type: "symlink", target: "releases/42", targetKind: "dir" },
      }),
      entry("dangling", {
        kind: { type: "symlink", target: "/nowhere", targetKind: null },
      }),
    ]);
    expect(screen.getAllByRole("img", { name: "Symbolic link" })).toHaveLength(
      2,
    );
    expect(screen.getByTitle("Link → releases/42")).toBeInTheDocument();
    expect(screen.getByTitle("Broken link → /nowhere")).toBeInTheDocument();
  });

  it("sorts by the clicked column and shows the direction", () => {
    const { onSort } = renderTable([entry("a")], {
      sort: { key: "size", dir: "desc" },
    });
    expect(screen.getByRole("columnheader", { name: /Size/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
    fireEvent.click(screen.getByRole("button", { name: /Modified/ }));
    expect(onSort).toHaveBeenCalledWith("mtime");
  });

  it("reports clicks with their modifiers and opens on double-click", () => {
    const a = entry("a");
    const { onRowClick, onOpen } = renderTable([a]);
    const [row] = dataRows();
    fireEvent.click(row, { metaKey: true });
    expect(onRowClick).toHaveBeenCalledWith(a, { meta: true, shift: false });
    fireEvent.click(row, { shiftKey: true });
    expect(onRowClick).toHaveBeenLastCalledWith(a, {
      meta: false,
      shift: true,
    });
    fireEvent.doubleClick(row);
    expect(onOpen).toHaveBeenCalledWith(a);
  });

  it("shows the selection", () => {
    renderTable([entry("a"), entry("b")], { selection: new Set(["/srv/b"]) });
    const [a, b] = dataRows();
    expect(a).toHaveAttribute("aria-selected", "false");
    expect(b).toHaveAttribute("aria-selected", "true");
  });

  it("moves with the arrow keys, opens with Enter and selects all", () => {
    const b = entry("b");
    const { onMove, onOpen, onSelectAll } = renderTable([entry("a"), b], {
      cursor: "/srv/b",
    });
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(onMove).toHaveBeenCalledWith(1, false);
    fireEvent.keyDown(grid, { key: "ArrowUp", shiftKey: true });
    expect(onMove).toHaveBeenLastCalledWith(-1, true);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(b);
    fireEvent.keyDown(grid, { key: "a", metaKey: true });
    expect(onSelectAll).toHaveBeenCalled();
  });

  it("shows the empty text without entries", () => {
    renderTable([]);
    expect(screen.getByText("This folder is empty.")).toBeInTheDocument();
  });

  describe("inline rename", () => {
    it("preselects the name without its extension and commits on Enter", () => {
      const onRenameCommit = vi.fn();
      const handlers = renderTable([entry("report.pdf")], {
        editing: "/srv/report.pdf",
        onRenameCommit,
        onRenameCancel: vi.fn(),
      });
      const input =
        screen.getByLabelText<HTMLInputElement>("Rename report.pdf");
      expect(input).toHaveFocus();
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);

      fireEvent.change(input, { target: { value: "summary.pdf" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onRenameCommit).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/srv/report.pdf" }),
        "summary.pdf",
      );
      // The grid's own Enter (open) never saw the key, and the list has the
      // focus back.
      expect(handlers.onOpen).not.toHaveBeenCalled();
      expect(screen.getByRole("grid")).toHaveFocus();
    });

    it("cancels on Escape and commits only once", () => {
      const onRenameCommit = vi.fn();
      const onRenameCancel = vi.fn();
      renderTable([entry("a.txt")], {
        editing: "/srv/a.txt",
        onRenameCommit,
        onRenameCancel,
      });
      const input = screen.getByLabelText("Rename a.txt");
      fireEvent.keyDown(input, { key: "Escape" });
      fireEvent.blur(input);
      expect(onRenameCancel).toHaveBeenCalledTimes(1);
      expect(onRenameCommit).not.toHaveBeenCalled();
    });

    it("commits when the field loses focus (as in Finder)", () => {
      const onRenameCommit = vi.fn();
      renderTable([entry("a.txt")], {
        editing: "/srv/a.txt",
        onRenameCommit,
        onRenameCancel: vi.fn(),
      });
      const input = screen.getByLabelText("Rename a.txt");
      fireEvent.change(input, { target: { value: "b.txt" } });
      fireEvent.blur(input);
      expect(onRenameCommit).toHaveBeenCalledWith(
        expect.objectContaining({ name: "a.txt" }),
        "b.txt",
      );
    });

    it("keeps clicks in the field away from the row", () => {
      const handlers = renderTable([entry("a.txt")], {
        editing: "/srv/a.txt",
        onRenameCommit: vi.fn(),
        onRenameCancel: vi.fn(),
      });
      const input = screen.getByLabelText("Rename a.txt");
      fireEvent.click(input);
      fireEvent.doubleClick(input);
      expect(handlers.onRowClick).not.toHaveBeenCalled();
      expect(handlers.onOpen).not.toHaveBeenCalled();
    });
  });

  it("uses onEnter instead of opening when given", () => {
    const onEnter = vi.fn();
    const handlers = renderTable([entry("a.txt")], {
      cursor: "/srv/a.txt",
      onEnter,
    });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter" });
    expect(onEnter).toHaveBeenCalledWith(
      expect.objectContaining({ name: "a.txt" }),
    );
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it("reports right-clicks on a row and on the empty area", () => {
    const onContextMenu = vi.fn();
    renderTable([entry("a.txt")], { onContextMenu });
    fireEvent.contextMenu(screen.getByText("a.txt"));
    expect(onContextMenu).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "a.txt" }),
      expect.anything(),
    );
    fireEvent.contextMenu(screen.getByRole("grid"));
    expect(onContextMenu).toHaveBeenLastCalledWith(null, expect.anything());
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });

  it("leaves Cmd+arrows to the pane", () => {
    const handlers = renderTable([entry("a.txt")]);
    fireEvent.keyDown(screen.getByRole("grid"), {
      key: "ArrowDown",
      metaKey: true,
    });
    expect(handlers.onMove).not.toHaveBeenCalled();
  });
});
