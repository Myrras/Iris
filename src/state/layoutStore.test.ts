import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return (await import("./layoutStore")).useLayoutStore;
}

describe("layoutStore", () => {
  beforeEach(() => localStorage.clear());

  it("clamps and persists the sidebar width", async () => {
    const store = await freshStore();
    store.getState().setSidebarWidth(5000);
    expect(store.getState().sidebarWidth).toBe(600);
    store.getState().setSidebarWidth(10);
    expect(store.getState().sidebarWidth).toBe(160);
    const reloaded = await freshStore();
    expect(reloaded.getState().sidebarWidth).toBe(160);
  });

  it("remembers the transfer panel's collapse across reloads", async () => {
    const store = await freshStore();
    expect(store.getState().transfersCollapsed).toBe(false);
    store.getState().setTransfersCollapsed(true);
    const reloaded = await freshStore();
    expect(reloaded.getState().transfersCollapsed).toBe(true);
  });

  it("opens the preview by default and remembers closing it", async () => {
    const store = await freshStore();
    expect(store.getState().previewOpen).toBe(true);
    store.getState().togglePreview();
    expect(store.getState().previewOpen).toBe(false);
    const reloaded = await freshStore();
    expect(reloaded.getState().previewOpen).toBe(false);
    reloaded.getState().setPreviewOpen(true);
    expect((await freshStore()).getState().previewOpen).toBe(true);
  });

  it("keeps an explicitly closed preview closed and opens it for old layouts", async () => {
    localStorage.setItem("iris.layout", JSON.stringify({ previewOpen: false }));
    expect((await freshStore()).getState().previewOpen).toBe(false);
    localStorage.setItem("iris.layout", JSON.stringify({ sidebarWidth: 300 }));
    expect((await freshStore()).getState().previewOpen).toBe(true);
  });
});
