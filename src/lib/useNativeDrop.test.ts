import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ mac: true }));
vi.mock("./platform", () => ({
  get isMac() {
    return platform.mac;
  },
  isWindows: false,
}));

type Payload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };
const native = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: Payload }) => void),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (e: { payload: Payload }) => void) => {
      native.handler = h;
      return Promise.resolve(native.unlisten);
    },
  }),
}));
vi.mock("../ipc/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/commands")>()),
  enqueueTransfers: vi.fn(() => Promise.resolve("b-1")),
  listTransfers: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("../state/toastStore", () => ({
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

import { enqueueTransfers } from "../ipc/commands";
import { useDragStore } from "../state/dragStore";
import { initialPane, usePaneStore } from "../state/paneStore";
import { useSessionStore } from "../state/sessionStore";
import { toastInfo } from "../state/toastStore";
import { useNativeDrop } from "./useNativeDrop";

let hit: Element | null = null;
const elementFromPoint = vi.fn(() => hit);

function fire(payload: Payload) {
  native.handler?.({ payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.mac = true;
  useDragStore.getState().end();
  document.body.innerHTML = `
    <section data-drop-pane="remote">
      <div data-drop-dir="/srv/www"><span id="www">www</span></div>
      <span id="empty">empty</span>
    </section>
    <section data-drop-pane="local"><span id="local">x</span></section>`;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: elementFromPoint,
  });
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
  document.body.innerHTML = "";
});

describe("useNativeDrop", () => {
  it("highlights the remote pane and uploads into the folder row", async () => {
    renderHook(() => useNativeDrop());
    await waitFor(() => expect(native.handler).not.toBeNull());

    hit = document.getElementById("www");
    fire({
      type: "enter",
      paths: ["/Users/alice/a.txt"],
      position: { x: 50, y: 60 },
    });
    expect(elementFromPoint).toHaveBeenCalledWith(50, 60);
    expect(useDragStore.getState()).toMatchObject({
      nativeDrag: true,
      over: { pane: "remote", dir: "/srv/www" },
    });

    fire({
      type: "drop",
      paths: ["/Users/alice/a.txt", "/Users/alice/pics"],
      position: { x: 50, y: 60 },
    });
    expect(useDragStore.getState().nativeDrag).toBe(false);
    await waitFor(() =>
      expect(enqueueTransfers).toHaveBeenCalledWith({
        sessionId: "s-1",
        direction: "upload",
        items: [{ src: "/Users/alice/a.txt" }, { src: "/Users/alice/pics" }],
        dstDir: "/srv/www",
      }),
    );
  });

  it("scales physical positions outside macOS and ignores the local pane", () => {
    platform.mac = false;
    const ratio = window.devicePixelRatio;
    window.devicePixelRatio = 2;
    renderHook(() => useNativeDrop());

    hit = document.getElementById("local");
    fire({ type: "over", position: { x: 100, y: 40 } });
    expect(elementFromPoint).toHaveBeenCalledWith(50, 20);
    expect(useDragStore.getState()).toMatchObject({
      nativeDrag: true,
      over: null,
    });
    fire({ type: "drop", paths: ["/tmp/a"], position: { x: 100, y: 40 } });
    expect(enqueueTransfers).not.toHaveBeenCalled();
    window.devicePixelRatio = ratio;
  });

  it("asks to connect first, and clears on leave", () => {
    useSessionStore.setState({ sessions: {} });
    usePaneStore.setState({
      panes: { ...usePaneStore.getState().panes, remote: initialPane() },
    });
    renderHook(() => useNativeDrop());

    hit = document.getElementById("empty");
    fire({ type: "enter", paths: ["/tmp/a"], position: { x: 1, y: 1 } });
    expect(useDragStore.getState().over).toEqual({
      pane: "remote",
      dir: null,
    });
    fire({ type: "leave" });
    expect(useDragStore.getState().nativeDrag).toBe(false);

    fire({ type: "drop", paths: ["/tmp/a"], position: { x: 1, y: 1 } });
    expect(toastInfo).toHaveBeenCalledWith("Connect to a server to upload");
    expect(enqueueTransfers).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useNativeDrop());
    unmount();
    await waitFor(() => expect(native.unlisten).toHaveBeenCalled());
  });
});
