import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drag = vi.hoisted(() => ({
  onEvent: null as null | ((p: { result: string }) => void),
}));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({
  startDrag: vi.fn(
    (_opts: unknown, onEvent: (p: { result: string }) => void) => {
      drag.onEvent = onEvent;
      return Promise.resolve();
    },
  ),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve("/Users/alice/Downloads")),
}));
const prep = vi.hoisted(() => ({
  resolve: null as null | ((v: unknown) => void),
  reject: null as null | ((e: unknown) => void),
}));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  prepareDragOut: vi.fn(
    () =>
      new Promise((resolve, reject) => {
        prep.resolve = resolve;
        prep.reject = reject;
      }),
  ),
  cancelDragOut: vi.fn(() => Promise.resolve()),
  finishDragOut: vi.fn(() => Promise.resolve()),
  enqueueTransfers: vi.fn(() => Promise.resolve("b-1")),
  listTransfers: vi.fn(() => new Promise(() => undefined)),
}));

import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import {
  cancelDragOut,
  enqueueTransfers,
  finishDragOut,
  prepareDragOut,
} from "../ipc/commands";
import { useDragStore } from "../state/dragStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useSessionStore } from "../state/sessionStore";
import { useToastStore } from "../state/toastStore";
import { dragOutProgress, PREPARE_TIMEOUT_MS } from "./dragOut";
import { beginPaneDrag } from "./paneDrag";

const W = window.innerWidth;

/** Press at (10, 10) and move far enough to start the drag. */
function press(from: "local" | "remote", items: string[]) {
  beginPaneDrag(from, 10, 10, () => items);
  fireEvent.mouseMove(document.body, { clientX: 40, clientY: 40, buttons: 1 });
}

/** Move the pointer past the window's right edge. */
function leave() {
  fireEvent.mouseMove(document.body, {
    clientX: W + 30,
    clientY: 40,
    buttons: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  drag.onEvent = null;
  prep.resolve = null;
  prep.reject = null;
  useDragStore.getState().end();
  useDragStore.getState().setDragOut(null);
  useToastStore.setState({ toasts: [] });
  document.body.innerHTML = `
    <section data-drop-pane="remote"><span id="remote">r</span></section>
    <section data-drop-pane="local"><span id="local">l</span></section>`;
  usePaneStore.setState({
    panes: {
      local: { ...initialPane(), target: { kind: "local" }, path: "/home" },
      remote: {
        ...initialPane(),
        target: { kind: "remote", sessionId: "s-1" },
        path: "/srv",
      },
    },
  });
  useSessionStore.setState({
    sessions: {
      "s-1": {
        sessionId: "s-1",
        profileId: "p-1",
        state: { status: "connected" },
      },
    },
  });
});

afterEach(() => {
  // End whatever drag a test left running.
  fireEvent.keyDown(window, { key: "Escape" });
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("dragging local rows out of the window", () => {
  it("hands the paths to the OS drag as soon as the pointer leaves", async () => {
    press("local", ["/home/a.txt", "/home/pics"]);
    expect(useDragStore.getState().paneDrag).not.toBeNull();
    leave();

    expect(startDrag).toHaveBeenCalledWith(
      expect.objectContaining({
        item: ["/home/a.txt", "/home/pics"],
        mode: "copy",
        icon: expect.stringMatching(/^data:image\/png;base64,/),
      }),
      expect.any(Function),
    );
    // The in-window drag is over; the OS owns the pointer.
    expect(useDragStore.getState().paneDrag).toBeNull();
    expect(useDragStore.getState().dragOut).toEqual({
      from: "local",
      paths: ["/home/a.txt", "/home/pics"],
    });
    expect(prepareDragOut).not.toHaveBeenCalled();
  });

  it("keeps dropping on the other pane inside the window", async () => {
    press("local", ["/home/a.txt"]);
    const target = document.getElementById("remote")!;
    fireEvent.mouseMove(target, { clientX: 400, clientY: 40, buttons: 1 });
    fireEvent.mouseUp(target, { clientX: 400, clientY: 40 });
    expect(startDrag).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(enqueueTransfers).toHaveBeenCalledWith({
        sessionId: "s-1",
        direction: "upload",
        items: [{ src: "/home/a.txt" }],
        dstDir: "/srv",
      }),
    );
  });
});

describe("dragging remote rows out of the window", () => {
  it("downloads them first, then starts the OS drag with the copies", async () => {
    press("remote", ["/srv/report.pdf"]);
    leave();
    expect(prepareDragOut).toHaveBeenCalledWith(expect.any(String), "s-1", [
      "/srv/report.pdf",
    ]);
    const id = vi.mocked(prepareDragOut).mock.calls[0][0];
    expect(useDragStore.getState().paneDrag?.preparing).toEqual({
      bytesDone: 0,
      totalBytes: 0,
    });
    act(() =>
      dragOutProgress({
        type: "dragOutProgress",
        dragId: id,
        bytesDone: 50,
        totalBytes: 200,
      }),
    );
    expect(useDragStore.getState().paneDrag?.preparing).toEqual({
      bytesDone: 50,
      totalBytes: 200,
    });
    expect(startDrag).not.toHaveBeenCalled();

    const copy = `/cache/dragout/${id}/report.pdf`;
    prep.resolve?.({ dragId: id, paths: [copy], files: 1, totalBytes: 200 });
    await waitFor(() =>
      expect(startDrag).toHaveBeenCalledWith(
        expect.objectContaining({ item: [copy] }),
        expect.any(Function),
      ),
    );
    expect(useDragStore.getState().paneDrag).toBeNull();
    expect(cancelDragOut).not.toHaveBeenCalled();

    drag.onEvent?.({ result: "Dropped" });
    await waitFor(() => expect(finishDragOut).toHaveBeenCalledWith(id, true));
  });

  it("waits for the pointer to leave again when it came back meanwhile", async () => {
    press("remote", ["/srv/report.pdf"]);
    leave();
    const id = vi.mocked(prepareDragOut).mock.calls[0][0];
    fireEvent.mouseMove(document.body, {
      clientX: 200,
      clientY: 40,
      buttons: 1,
    });
    prep.resolve?.({
      dragId: id,
      paths: ["/c/r.pdf"],
      files: 1,
      totalBytes: 1,
    });
    // Ready: the ghost stops showing the download.
    await waitFor(() =>
      expect(useDragStore.getState().paneDrag?.preparing).toBeNull(),
    );
    expect(startDrag).not.toHaveBeenCalled();
    leave();
    expect(startDrag).toHaveBeenCalled();
    drag.onEvent?.({ result: "Cancel" });
    await waitFor(() => expect(finishDragOut).toHaveBeenCalledWith(id, false));
  });

  it("throws the copies away when released inside the window", async () => {
    press("remote", ["/srv/report.pdf"]);
    leave();
    const id = vi.mocked(prepareDragOut).mock.calls[0][0];
    fireEvent.mouseMove(document.body, {
      clientX: 200,
      clientY: 40,
      buttons: 1,
    });
    fireEvent.mouseUp(document.body, { clientX: 200, clientY: 40 });
    expect(cancelDragOut).toHaveBeenCalledWith(id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("offers Download to… when the selection is too large", async () => {
    press("remote", ["/srv/backups"]);
    leave();
    prep.reject?.({
      kind: "tooLarge",
      message: "too large: a drag can bring along up to 500 files and 200 MB",
    });
    await waitFor(() =>
      expect(useToastStore.getState().toasts).toHaveLength(1),
    );
    const toast = useToastStore.getState().toasts[0];
    expect(toast).toMatchObject({
      message: "Too large to drag out",
      action: { label: "Download to…" },
    });
    expect(useDragStore.getState().paneDrag).toBeNull();
    expect(startDrag).not.toHaveBeenCalled();

    await act(() => toast.action!.onClick());
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, defaultPath: "/home" }),
    );
    await waitFor(() =>
      expect(enqueueTransfers).toHaveBeenCalledWith({
        sessionId: "s-1",
        direction: "download",
        items: [{ src: "/srv/backups" }],
        dstDir: "/Users/alice/Downloads",
      }),
    );
  });

  it("gives up and offers Download to… when preparing takes too long", async () => {
    vi.useFakeTimers();
    press("remote", ["/srv/video.mov"]);
    leave();
    const id = vi.mocked(prepareDragOut).mock.calls[0][0];
    vi.advanceTimersByTime(PREPARE_TIMEOUT_MS);
    expect(cancelDragOut).toHaveBeenCalledWith(id);
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: "Preparing the drag took too long",
      action: { label: "Download to…" },
    });
    // The core answers the cancel.
    prep.reject?.({ kind: "cancelled", message: "cancelled" });
    await vi.runAllTimersAsync();
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(startDrag).not.toHaveBeenCalled();
  });

  it("offers Download to… when released outside before the files are ready", () => {
    press("remote", ["/srv/report.pdf"]);
    leave();
    const id = vi.mocked(prepareDragOut).mock.calls[0][0];
    fireEvent.mouseUp(document.body, { clientX: W + 30, clientY: 40 });
    expect(cancelDragOut).toHaveBeenCalledWith(id);
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      message: "Released before the files were ready",
      action: { label: "Download to…" },
    });
  });
});

describe("text selection during a drag", () => {
  const start = () => {
    beginPaneDrag("local", 10, 10, () => ["/home/a"]);
    fireEvent.mouseMove(document.body, {
      clientX: 40,
      clientY: 40,
      buttons: 1,
    });
  };
  const flag = () => document.documentElement.dataset.dragging;

  it("flags the document while dragging and clears it on mouseup", () => {
    start();
    expect(flag()).toBe("true");
    fireEvent.mouseUp(document.body, { clientX: 40, clientY: 40 });
    expect(flag()).toBeUndefined();
  });

  it("clears the flag on Escape", () => {
    start();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(flag()).toBeUndefined();
  });

  it("drops an existing text selection when the drag starts", () => {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(document.body);
    sel?.addRange(range);
    start();
    expect(sel?.rangeCount).toBe(0);
  });
});
