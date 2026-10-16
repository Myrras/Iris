import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  preview: vi.fn(),
}));

import { preview } from "../ipc/commands";
import type { Entry, Preview } from "../ipc/types";
import { useLayoutStore } from "../state/layoutStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useSettingsStore } from "../state/settingsStore";
import { PreviewPanel } from "./PreviewPanel";

function entry(name: string, extra: Partial<Entry> = {}): Entry {
  return {
    name,
    path: `/srv/${name}`,
    kind: { type: "file" },
    size: 100,
    mtime: 1_700_000_000,
    mode: 0o100644,
    hidden: false,
    ...extra,
  };
}

/** Show `entries` in the remote pane with `focused` selected and active. */
function focus(entries: Entry[], focused: string | null) {
  usePaneStore.setState({
    active: "remote",
    panes: {
      local: initialPane(),
      remote: {
        ...initialPane(),
        target: { kind: "remote", sessionId: "s-1" },
        path: "/srv",
        entries,
        selection: focused ? [focused] : [],
        cursor: focused,
        anchor: focused,
      },
    },
  });
}

function answer(p: Preview) {
  vi.mocked(preview).mockResolvedValue(p);
}

beforeEach(() => {
  vi.mocked(preview).mockReset();
  useLayoutStore.getState().setPreviewOpen(true);
  useSettingsStore.getState().set("preview", { maxSizeMb: 2 });
});

const text = (t: string): Preview => ({
  kind: "text",
  text: t,
  truncated: false,
  totalSize: t.length,
});

/** Let the debounce and the mocked read settle. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 250)));

/** Move the focus to `path` in the remote pane. */
function moveTo(path: string) {
  act(() =>
    usePaneStore.getState().setSelection("remote", {
      selection: [path],
      anchor: path,
      cursor: path,
    }),
  );
}

describe("PreviewPanel", () => {
  it("shows a strip, not the island, when closed and previewable", async () => {
    useLayoutStore.getState().setPreviewOpen(false);
    answer(text("hi"));
    focus([entry("a.txt")], "/srv/a.txt");
    render(<PreviewPanel />);
    const show = await screen.findByRole("button", { name: "Show preview" });
    expect(screen.queryByText("hi")).toBeNull();
    fireEvent.click(show);
    expect(useLayoutStore.getState().previewOpen).toBe(true);
    expect(await screen.findByText("hi")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show preview" })).toBeNull();
  });

  it("renders nothing when closed and not previewable", async () => {
    useLayoutStore.getState().setPreviewOpen(false);
    answer({ kind: "binary", totalSize: 1 });
    focus([entry("a.bin")], "/srv/a.bin");
    const { container } = render(<PreviewPanel />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("previews text with the size cap from the settings", async () => {
    answer(text("hello world"));
    focus([entry("notes.txt")], "/srv/notes.txt");
    render(<PreviewPanel />);
    expect(await screen.findByText("hello world")).toBeInTheDocument();
    expect(preview).toHaveBeenCalledWith(
      { kind: "remote", sessionId: "s-1" },
      "/srv/notes.txt",
      2 * 1024 * 1024,
    );
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says when only the start of a text file is shown", async () => {
    answer({
      kind: "text",
      text: "a".repeat(2048),
      truncated: true,
      totalSize: 5 * 1024 * 1024,
    });
    focus([entry("big.log")], "/srv/big.log");
    render(<PreviewPanel />);
    expect(await screen.findByRole("note")).toHaveTextContent(
      "Showing the first 2.0 KB of 5.0 MB.",
    );
  });

  it("renders images through a data URL only", async () => {
    answer({
      kind: "image",
      mime: "image/svg+xml",
      dataBase64: "PHN2Zy8+",
      totalSize: 6,
    });
    focus([entry("logo.svg")], "/srv/logo.svg");
    const { container } = render(<PreviewPanel />);
    const img = await screen.findByRole("img", { name: "logo.svg" });
    expect(img).toHaveAttribute("src", "data:image/svg+xml;base64,PHN2Zy8+");
    // The markup itself is never in the page (only the UI's own icons are).
    expect(container.querySelector("svg:not(.lucide)")).toBeNull();
  });

  it.each<[string, Preview | "error"]>([
    [
      "an unsupported image",
      { kind: "image", mime: "text/html", dataBase64: "PGI+", totalSize: 3 },
    ],
    ["a binary file", { kind: "binary", totalSize: 2048 }],
    ["a too large file", { kind: "tooLarge", totalSize: 50 * 1024 * 1024 }],
    ["an empty file", text("")],
    ["a read error", "error"],
  ])("renders nothing for %s", async (_, result) => {
    if (result === "error")
      vi.mocked(preview).mockRejectedValue({
        kind: "permissionDenied",
        message: "permission denied",
      });
    else answer(result);
    focus([entry("x.dat")], "/srv/x.dat");
    const { container } = render(<PreviewPanel />);
    await settle();
    expect(preview).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for no selection, folders, specials and broken links", async () => {
    const entries = [
      entry("docs", { kind: { type: "dir" } }),
      entry("sock", { kind: { type: "other" } }),
      entry("dead", {
        kind: { type: "symlink", target: "/nope", targetKind: null },
      }),
    ];
    focus(entries, null);
    const { container } = render(<PreviewPanel />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    for (const e of entries) {
      moveTo(e.path);
      await settle();
      expect(container).toBeEmptyDOMElement();
    }
    expect(preview).not.toHaveBeenCalled();
  });

  it("does not flash when moving between unpreviewable files", async () => {
    answer({ kind: "binary", totalSize: 1 });
    focus([entry("a.bin"), entry("b.bin")], "/srv/a.bin");
    const { container } = render(<PreviewPanel />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    moveTo("/srv/b.bin");
    expect(container).toBeEmptyDOMElement();
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("stays up while the next file loads, and hides for a folder", async () => {
    answer(text("first"));
    focus(
      [
        entry("a.txt"),
        entry("b.txt"),
        entry("docs", { kind: { type: "dir" } }),
      ],
      "/srv/a.txt",
    );
    render(<PreviewPanel />);
    expect(await screen.findByText("first")).toBeInTheDocument();

    let resolve!: (p: Preview) => void;
    vi.mocked(preview).mockReturnValue(new Promise((r) => (resolve = r)));
    moveTo("/srv/b.txt");
    await settle();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();

    await act(async () => resolve(text("second")));
    expect(await screen.findByText("second")).toBeInTheDocument();

    moveTo("/srv/docs");
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });

  it("hides after a text file when the next one is binary", async () => {
    answer(text("first"));
    focus([entry("a.txt"), entry("b.bin")], "/srv/a.txt");
    render(<PreviewPanel />);
    expect(await screen.findByText("first")).toBeInTheDocument();
    answer({ kind: "binary", totalSize: 1 });
    moveTo("/srv/b.bin");
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });
});
