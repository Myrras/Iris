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

  it("shows favorites by default and remembers folding them per connection", async () => {
    const store = await freshStore();
    expect(store.getState().collapsedFavorites).toEqual([]);
    store.getState().setFavoritesExpanded("p-1", false);
    store.getState().setFavoritesExpanded("p-2", false);
    store.getState().setFavoritesExpanded("p-2", true);
    const reloaded = await freshStore();
    expect(reloaded.getState().collapsedFavorites).toEqual(["p-1"]);
    localStorage.setItem(
      "iris.layout",
      JSON.stringify({ collapsedFavorites: "nonsense" }),
    );
    expect((await freshStore()).getState().collapsedFavorites).toEqual([]);
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

  it("starts with the default sizes", async () => {
    const state = (await freshStore()).getState();
    expect(state.sidebarWidth).toBe(280);
    expect(state.panesRatio).toBe(0.5);
    expect(state.previewWidth).toBe(340);
    expect(state.transfersHeight).toBe(168);
  });

  it("clamps and persists every size, restoring it after a reload", async () => {
    const store = await freshStore();
    store.getState().setPanesRatio(0.62);
    store.getState().setPreviewWidth(420);
    store.getState().setTransfersHeight(240);
    store.getState().setSidebarWidth(310);
    const reloaded = (await freshStore()).getState();
    expect(reloaded.panesRatio).toBe(0.62);
    expect(reloaded.previewWidth).toBe(420);
    expect(reloaded.transfersHeight).toBe(240);
    expect(reloaded.sidebarWidth).toBe(310);

    store.getState().setPanesRatio(7);
    expect(store.getState().panesRatio).toBe(0.95);
    store.getState().setPreviewWidth(10);
    expect(store.getState().previewWidth).toBe(240);
    store.getState().setTransfersHeight(0);
    expect(store.getState().transfersHeight).toBe(56);
  });

  it("merges an old layout over the defaults: missing keys mean defaults", async () => {
    localStorage.setItem(
      "iris.layout",
      JSON.stringify({ sidebarWidth: 330, transfersCollapsed: true }),
    );
    const state = (await freshStore()).getState();
    expect(state.sidebarWidth).toBe(330);
    expect(state.transfersCollapsed).toBe(true);
    expect(state.panesRatio).toBe(0.5);
    expect(state.previewWidth).toBe(340);
    expect(state.transfersHeight).toBe(168);
    expect(state.previewOpen).toBe(true);
  });

  it("ignores values it cannot use", async () => {
    localStorage.setItem(
      "iris.layout",
      JSON.stringify({
        sidebarWidth: "wide",
        panesRatio: null,
        previewWidth: 99999,
        transfersHeight: -5,
      }),
    );
    const state = (await freshStore()).getState();
    expect(state.sidebarWidth).toBe(280);
    expect(state.panesRatio).toBe(0.5);
    expect(state.previewWidth).toBe(4000);
    expect(state.transfersHeight).toBe(56);
    localStorage.setItem("iris.layout", "not json");
    expect((await freshStore()).getState().previewWidth).toBe(340);
    localStorage.setItem("iris.layout", "null");
    expect((await freshStore()).getState().previewWidth).toBe(340);
  });

  it("keeps the preview width while it is closed", async () => {
    const store = await freshStore();
    store.getState().setPreviewWidth(500);
    store.getState().setPreviewOpen(false);
    store.getState().setPreviewOpen(true);
    expect(store.getState().previewWidth).toBe(500);
    expect((await freshStore()).getState().previewWidth).toBe(500);
  });
});
