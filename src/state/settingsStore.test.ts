import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return (await import("./settingsStore")).useSettingsStore;
}

describe("settingsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.reduceMotion;
  });

  it("starts from the defaults", async () => {
    const s = (await freshStore()).getState();
    expect(s.appearance.reduceMotion).toBe(false);
    expect(s.browser.showHidden).toBe(false);
    expect(s.preview.maxSizeMb).toBe(10);
  });

  it("deep-merges a saved blob over the defaults per section", async () => {
    // An older blob without the preview section and a partial browser one.
    localStorage.setItem(
      "iris.settings",
      JSON.stringify({ browser: { showHidden: true } }),
    );
    const s = (await freshStore()).getState();
    expect(s.browser.showHidden).toBe(true);
    expect(s.preview.maxSizeMb).toBe(10);
    expect(s.appearance.reduceMotion).toBe(false);
  });

  it("falls back to defaults on a corrupt blob", async () => {
    localStorage.setItem("iris.settings", "{not json");
    const s = (await freshStore()).getState();
    expect(s.browser.showHidden).toBe(false);
  });

  it("persists a section patch under iris.settings", async () => {
    const store = await freshStore();
    store.getState().set("preview", { maxSizeMb: 25 });
    expect(store.getState().preview.maxSizeMb).toBe(25);
    const saved = JSON.parse(localStorage.getItem("iris.settings") ?? "{}");
    expect(saved.preview.maxSizeMb).toBe(25);
    expect(saved.browser.showHidden).toBe(false);
  });

  it("applies the reduce-motion override to <html>", async () => {
    const store = await freshStore();
    store.getState().set("appearance", { reduceMotion: true });
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
    store.getState().set("appearance", { reduceMotion: false });
    expect(document.documentElement.dataset.reduceMotion).toBeUndefined();
  });

  it("resets to the defaults", async () => {
    const store = await freshStore();
    store.getState().set("browser", { showHidden: true });
    store.getState().resetSettings();
    expect(store.getState().browser.showHidden).toBe(false);
    expect(localStorage.getItem("iris.settings")).toBeNull();
  });
});
