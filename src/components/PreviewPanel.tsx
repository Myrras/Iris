/**
 * The preview island right of the panes (Quick Look-style; Space or the pane
 * toolbar toggles it). It follows the focused entry of the active pane: text
 * in monospace (the start only for large files, with a notice), images fitted
 * on a checkerboard, and a short note for folders, binary files and images
 * over the size limit. Always open at a fixed width (`--preview-w`) until the
 * user closes it (`layoutStore.previewOpen`, persisted). Closed, it takes no
 * space at all: a small handle slides in from the window's right edge (it
 * overlays the layout) when the focused file looks previewable or the pointer
 * is at that edge, and reopens the island.
 *
 * SVG arrives as an image and is only ever shown through an `<img>` data URL,
 * which cannot run scripts; preview markup is never injected into the page.
 */

import { useEffect, useRef, useState } from "react";

import { preview as fetchPreview, toIpcError } from "../ipc/commands";
import type { Entry, FsTarget, Preview } from "../ipc/types";
import { isDirLike } from "../lib/entries";
import {
  EDGE_REVEAL_PX,
  HANDLE_HIDE_DELAY_MS,
  looksPreviewable,
  previewable,
} from "../lib/previewReveal";
import { formatSize } from "../lib/fileFormat";
import { previewTitle } from "../lib/keymap";
import { MOTION, usePresence } from "../lib/motion";
import { useKeymap } from "../lib/useKeymap";
import { useLayoutStore } from "../state/layoutStore";
import { focusedEntry, usePaneStore } from "../state/paneStore";
import { useSettingsStore } from "../state/settingsStore";
import {
  BinaryFileIcon,
  FolderLargeIcon,
  PreviewCloseIcon,
  PreviewIcon,
  TextFileIcon,
  TooLargeIcon,
} from "./icons";
import styles from "./PreviewPanel.module.css";

/** Wait this long after the selection settles before reading the file. */
export const PREVIEW_DEBOUNCE_MS = 120;

/** The image types the backend produces; anything else is not rendered. */
const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

type Load =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; preview: Preview }
  | { state: "error"; message: string };

function targetKey(target: FsTarget | null): string {
  if (!target) return "";
  return target.kind === "remote" ? target.sessionId : "local";
}

/** Fetch the preview of `entry`, debounced, dropping stale answers. */
function usePreview(
  target: FsTarget | null,
  entry: Entry | null,
  maxBytes: number,
  enabled: boolean,
): Load {
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const key = targetKey(target);
  const path = entry && previewable(entry) ? entry.path : null;
  // A changed size or mtime (after a refresh) re-reads the file.
  const version = entry ? `${entry.size}:${entry.mtime}` : "";

  useEffect(() => {
    if (!enabled || !target || path === null) {
      setLoad({ state: "idle" });
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    const timer = setTimeout(() => {
      fetchPreview(target, path, maxBytes).then(
        (preview) => {
          if (!cancelled) setLoad({ state: "ready", preview });
        },
        (e) => {
          if (!cancelled)
            setLoad({ state: "error", message: toIpcError(e).message });
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `target` is identified by `key`; its object identity may change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, path, version, maxBytes]);

  return load;
}

export function PreviewPanel() {
  const open = useLayoutStore((s) => s.previewOpen);
  return open ? <PreviewIsland /> : <RevealHandle />;
}

/** Whether the pointer is at the window's right edge. */
function useEdgeHover(active: boolean): boolean {
  const [edge, setEdge] = useState(false);
  useEffect(() => {
    if (!active) return;
    const onMove = (e: MouseEvent) =>
      setEdge(e.clientX >= window.innerWidth - EDGE_REVEAL_PX);
    const onLeave = () => setEdge(false);
    document.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      setEdge(false);
    };
  }, [active]);
  return edge;
}

/** Follows `want`: true at once, false only after `delay`. */
function useLingering(want: boolean, delay: number): boolean {
  const [shown, setShown] = useState(want);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    if (want) setShown(true);
    else timer.current = setTimeout(() => setShown(false), delay);
    return () => clearTimeout(timer.current);
  }, [want, delay]);
  return shown;
}

/** The closed state: no layout space, just an overlay handle on the edge. */
function RevealHandle() {
  const keymap = useKeymap();
  const entry = usePaneStore((s) => focusedEntry(s.panes[s.active]));
  const maxSizeMb = useSettingsStore((s) => s.preview.maxSizeMb);
  const edge = useEdgeHover(true);
  const [hovered, setHovered] = useState(false);
  const want =
    looksPreviewable(entry, maxSizeMb * 1024 * 1024) || edge || hovered;
  const shown = useLingering(want, HANDLE_HIDE_DELAY_MS);
  const { mounted, state } = usePresence(shown, MOTION.base);
  if (!mounted) return null;
  return (
    <button
      type="button"
      className={styles.handle}
      data-state={state}
      aria-label="Show preview"
      title={previewTitle("Show preview", keymap)}
      tabIndex={state === "open" ? 0 : -1}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onClick={() => useLayoutStore.getState().setPreviewOpen(true)}
    >
      <PreviewIcon />
    </button>
  );
}

function PreviewIsland() {
  const keymap = useKeymap();
  const setOpen = useLayoutStore((s) => s.setPreviewOpen);
  const target = usePaneStore((s) => s.panes[s.active].target);
  const entry = usePaneStore((s) => focusedEntry(s.panes[s.active]));
  const maxSizeMb = useSettingsStore((s) => s.preview.maxSizeMb);
  const load = usePreview(target, entry, maxSizeMb * 1024 * 1024, true);

  return (
    <aside className={styles.panel} aria-label="Preview">
      <header className={styles.header}>
        <PreviewIcon className={styles.icon} />
        <h2 className={styles.title}>Preview</h2>
        {entry && (
          <span className={styles.subtitle} title={entry.path}>
            {entry.name}
          </span>
        )}
        <button
          type="button"
          className={styles.tool}
          aria-label="Hide preview"
          title={previewTitle("Hide preview", keymap)}
          aria-expanded={true}
          onClick={() => setOpen(false)}
        >
          <PreviewCloseIcon />
        </button>
      </header>
      <div className={styles.body}>
        <PreviewBody entry={entry} load={load} maxSizeMb={maxSizeMb} />
      </div>
    </aside>
  );
}

function Note({
  Icon,
  title,
  text,
}: {
  Icon?: typeof BinaryFileIcon;
  title: string;
  text?: string;
}) {
  return (
    <div className={styles.note}>
      {Icon && <Icon className={styles.noteIcon} />}
      <p className={styles.noteTitle}>{title}</p>
      {text && <p className={styles.noteText}>{text}</p>}
    </div>
  );
}

function PreviewBody({
  entry,
  load,
  maxSizeMb,
}: {
  entry: Entry | null;
  load: Load;
  maxSizeMb: number;
}) {
  if (!entry) return <Note title="Select a file to preview it." />;
  if (isDirLike(entry))
    return <Note Icon={FolderLargeIcon} title="Folder" text={entry.name} />;
  if (entry.kind.type === "other")
    return <Note title="No preview for special files." />;
  if (entry.kind.type === "symlink" && entry.kind.targetKind === null)
    return (
      <Note
        title="Broken link"
        text={`Points to ${entry.kind.target ?? "an unreadable target"}.`}
      />
    );

  switch (load.state) {
    case "idle":
    case "loading":
      return <p className={styles.loading}>Loading preview…</p>;
    case "error":
      return <Note title="No preview" text={load.message} />;
  }

  const preview = load.preview;
  switch (preview.kind) {
    case "text":
      return <TextPreview preview={preview} />;
    case "image":
      if (!IMAGE_MIMES.has(preview.mime))
        return <Note Icon={BinaryFileIcon} title="Unsupported image" />;
      return (
        <figure className={styles.figure}>
          <div className={styles.checker}>
            <img
              className={styles.image}
              src={`data:${preview.mime};base64,${preview.dataBase64}`}
              alt={entry.name}
              draggable={false}
            />
          </div>
          <figcaption className={styles.caption}>
            {formatSize(preview.totalSize)}
          </figcaption>
        </figure>
      );
    case "binary":
      return (
        <Note
          Icon={BinaryFileIcon}
          title="Binary file"
          text={`${formatSize(preview.totalSize)} · no preview for this kind of file.`}
        />
      );
    case "tooLarge":
      return (
        <Note
          Icon={TooLargeIcon}
          title="Too large to preview"
          text={`${formatSize(preview.totalSize)} is over the ${maxSizeMb} MB preview limit (Settings).`}
        />
      );
  }
}

function TextPreview({
  preview,
}: {
  preview: Extract<Preview, { kind: "text" }>;
}) {
  if (preview.text.length === 0)
    return <Note Icon={TextFileIcon} title="Empty file" />;
  const shown = new TextEncoder().encode(preview.text).length;
  return (
    <div className={styles.textWrap}>
      {preview.truncated && (
        <p className={styles.notice} role="note">
          Showing the first {formatSize(shown)} of{" "}
          {formatSize(preview.totalSize)}.
        </p>
      )}
      <pre className={styles.text}>{preview.text}</pre>
    </div>
  );
}
