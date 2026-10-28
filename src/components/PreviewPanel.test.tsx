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
import { HANDLE_HIDE_DELAY_MS } from "../lib/previewReveal";
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

describe("PreviewPanel", () => {
  describe("closed", () => {
    beforeEach(() => useLayoutStore.getState().setPreviewOpen(false));

    it("renders no island or strip and reads nothing", async () => {
      focus([entry("a.zip")], "/srv/a.zip");
      const { container } = render(<PreviewPanel />);
      expect(screen.queryByRole("complementary")).toBeNull();
      await act(() => new Promise((r) => setTimeout(r, 250)));
      expect(container).toBeEmptyDOMElement();
      expect(preview).not.toHaveBeenCalled();
    });

    it("shows the handle for a previewable file without reading it", async () => {
      focus([entry("a.txt")], "/srv/a.txt");
      render(<PreviewPanel />);
      await act(() => new Promise((r) => setTimeout(r, 250)));
      expect(preview).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
      expect(useLayoutStore.getState().previewOpen).toBe(true);
    });

    it.each([
      ["a folder", entry("docs", { kind: { type: "dir" } })],
      ["a binary file", entry("a.zip")],
      ["an empty file", entry("e.txt", { size: 0 })],
      ["a big image", entry("p.png", { size: 50 * 1024 * 1024 })],
    ])("hides the handle for %s", (_, e) => {
      focus([e], e.path);
      const { container } = render(<PreviewPanel />);
      expect(container).toBeEmptyDOMElement();
    });

    it("slides in at the right edge and out after leaving", () => {
      vi.useFakeTimers();
      try {
        focus([entry("a.zip")], "/srv/a.zip");
        const { container } = render(<PreviewPanel />);
        const move = (x: number) =>
          act(() => {
            fireEvent.mouseMove(document, { clientX: x });
          });
        move(window.innerWidth - 2);
        expect(
          screen.getByRole("button", { name: "Show preview" }),
        ).toBeInTheDocument();
        move(window.innerWidth / 2);
        act(() => {
          vi.advanceTimersByTime(HANDLE_HIDE_DELAY_MS - 50);
        });
        expect(container).not.toBeEmptyDOMElement();
        act(() => {
          vi.advanceTimersByTime(50);
        });
        // Slid out (closed state), then unmounted after the exit animation.
        expect(screen.getByRole("button")).toHaveAttribute(
          "data-state",
          "closed",
        );
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(container).toBeEmptyDOMElement();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays while the pointer is on the handle", () => {
      vi.useFakeTimers();
      try {
        focus([entry("a.zip")], "/srv/a.zip");
        const { container } = render(<PreviewPanel />);
        act(() => {
          fireEvent.mouseMove(document, { clientX: window.innerWidth - 1 });
        });
        const handle = screen.getByRole("button", { name: "Show preview" });
        fireEvent.pointerEnter(handle);
        act(() => {
          fireEvent.mouseMove(document, { clientX: window.innerWidth - 20 });
          vi.advanceTimersByTime(2000);
        });
        expect(container).not.toBeEmptyDOMElement();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  const settle = () => act(() => new Promise((r) => setTimeout(r, 250)));
  const moveTo = (path: string) =>
    act(() =>
      usePaneStore.getState().setSelection("remote", {
        selection: [path],
        anchor: path,
        cursor: path,
      }),
    );

  it("keeps the same island (fixed width class) for every kind of content", async () => {
    const big = entry("big.txt");
    focus(
      [big, entry("p.png"), entry("docs", { kind: { type: "dir" } })],
      null,
    );
    render(<PreviewPanel />);
    const island = screen.getByRole("complementary");
    const cls = island.className;
    expect(island).not.toHaveAttribute("style");
    const states: [string, Preview | null][] = [
      ["/srv/docs", null],
      [
        "/srv/big.txt",
        {
          kind: "text",
          text: "x".repeat(5000),
          truncated: false,
          totalSize: 5000,
        },
      ],
      [
        "/srv/p.png",
        { kind: "image", mime: "image/png", dataBase64: "AAAA", totalSize: 3 },
      ],
    ];
    for (const [path, result] of states) {
      if (result) answer(result);
      moveTo(path);
      // Loading line first, then the content.
      expect(screen.getByRole("complementary").className).toBe(cls);
      await settle();
      expect(screen.getByRole("complementary").className).toBe(cls);
      expect(screen.getByRole("complementary")).toBe(island);
    }
  });

  it("is open by default", () => {
    expect(useLayoutStore.getState().previewOpen).toBe(true);
  });

  it("previews text with the size cap from the settings", async () => {
    answer({
      kind: "text",
      text: "hello world",
      truncated: false,
      totalSize: 11,
    });
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

  it("refuses image types the backend never sends", async () => {
    answer({
      kind: "image",
      mime: "text/html",
      dataBase64: "PGI+",
      totalSize: 3,
    });
    focus([entry("x.png")], "/srv/x.png");
    render(<PreviewPanel />);
    expect(await screen.findByText("Unsupported image")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("explains binary and too-large files", async () => {
    answer({ kind: "binary", totalSize: 2048 });
    focus([entry("a.bin"), entry("huge.png")], "/srv/a.bin");
    render(<PreviewPanel />);
    expect(await screen.findByText("Binary file")).toBeInTheDocument();

    answer({ kind: "tooLarge", totalSize: 50 * 1024 * 1024 });
    usePaneStore.getState().setSelection("remote", {
      selection: ["/srv/huge.png"],
      anchor: "/srv/huge.png",
      cursor: "/srv/huge.png",
    });
    expect(await screen.findByText("Too large to preview")).toBeInTheDocument();
    expect(
      screen.getByText("50.0 MB is over the 2 MB preview limit (Settings)."),
    ).toBeInTheDocument();
  });

  it("does not read folders and waits for a selection", async () => {
    focus([entry("docs", { kind: { type: "dir" } })], "/srv/docs");
    const { rerender } = render(<PreviewPanel />);
    expect(screen.getByText("Folder")).toBeInTheDocument();
    focus([entry("docs", { kind: { type: "dir" } })], null);
    rerender(<PreviewPanel />);
    expect(
      screen.getByText("Select a file to preview it."),
    ).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 200));
    expect(preview).not.toHaveBeenCalled();
  });

  it("shows the error text when the file cannot be read", async () => {
    vi.mocked(preview).mockRejectedValue({
      kind: "permissionDenied",
      message: "permission denied: /srv/secret.txt",
    });
    focus([entry("secret.txt")], "/srv/secret.txt");
    render(<PreviewPanel />);
    await waitFor(() =>
      expect(
        screen.getByText("permission denied: /srv/secret.txt"),
      ).toBeInTheDocument(),
    );
  });
});
