/**
 * Drives the shell's resizable sizes. The stored preferences
 * (`layoutStore`) and the window size go through `resolveLayout`; the result
 * is written to CSS custom properties on the layout container
 * (`--sidebar-w`, `--preview-w`, `--pane-*-grow`, `--transfers-list-h`), so a
 * drag moves the islands with plain style writes and no React render.
 * `draft` previews a size that is not stored yet (a splitter's per-frame
 * `onResize`); the store is written once on release.
 *
 * A window resize re-resolves (coalesced to one per frame) without touching
 * the stored sizes: shrinking the window squeezes what is drawn, growing it
 * again gives the chosen sizes back.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useLayoutStore } from "../state/layoutStore";
import {
  layoutVars,
  resolveLayout,
  type LayoutPrefs,
  type ResolvedLayout,
  type Viewport,
} from "./resize";

function readViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function applyVars(el: HTMLElement | null, layout: ResolvedLayout) {
  if (!el) return;
  for (const [name, value] of Object.entries(layoutVars(layout))) {
    el.style.setProperty(name, value);
  }
}

export function useShellLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const panesRatio = useLayoutStore((s) => s.panesRatio);
  const previewWidth = useLayoutStore((s) => s.previewWidth);
  const previewOpen = useLayoutStore((s) => s.previewOpen);
  const transfersHeight = useLayoutStore((s) => s.transfersHeight);
  const transfersCollapsed = useLayoutStore((s) => s.transfersCollapsed);

  const prefs = useMemo<LayoutPrefs>(
    () => ({
      sidebarWidth,
      panesRatio,
      previewWidth,
      previewOpen,
      transfersHeight,
      transfersCollapsed,
    }),
    [
      sidebarWidth,
      panesRatio,
      previewWidth,
      previewOpen,
      transfersHeight,
      transfersCollapsed,
    ],
  );
  const [viewport, setViewport] = useState(readViewport);
  const layout = useMemo(
    () => resolveLayout(prefs, viewport),
    [prefs, viewport],
  );

  // The latest inputs for `draft`, whose identity must stay stable.
  const latest = useRef({ prefs, viewport });
  useLayoutEffect(() => {
    latest.current = { prefs, viewport };
  }, [prefs, viewport]);

  useLayoutEffect(() => {
    applyVars(ref.current, layout);
  }, [layout]);

  useEffect(() => {
    let frame: number | null = null;
    const onResize = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const next = readViewport();
        setViewport((prev) =>
          prev.width === next.width && prev.height === next.height
            ? prev
            : next,
        );
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  /** Show `patch` over the stored sizes without storing it. */
  const draft = useCallback((patch: Partial<LayoutPrefs>) => {
    const { prefs: p, viewport: v } = latest.current;
    applyVars(ref.current, resolveLayout({ ...p, ...patch }, v));
  }, []);

  return { ref, layout, draft };
}
