/**
 * The preview island right of the panes (Quick Look-style; Space or the pane
 * toolbar toggles it). It follows the focused entry of the active pane and
 * exists only when that entry has something to show: non-empty text (in
 * monospace; the start only for large files, with a notice) or a supported
 * image (fitted on a checkerboard). For anything else (no selection, folder,
 * special file, broken link, binary, too large, empty, unreadable) nothing is
 * rendered, so the panes take the full width.
 *
 * `layoutStore.previewOpen` stays the user's preference: open + previewable is
 * the full island, closed + previewable a slim strip, not previewable nothing.
 * The file is read even while collapsed, to know whether there is a strip to
 * show. While a read is pending the island keeps its previous state and
 * content; a hidden island stays hidden until the result is displayable, so
 * moving between unpreviewable files never flashes it. Appearing and
 * disappearing use `usePresence` (the exit animation runs before unmount).
 *
 * SVG arrives as an image and is only ever shown through an `<img>` data URL,
 * which cannot run scripts; preview markup is never injected into the page.
 */
import { useEffect, useState } from "react";

import { preview as fetchPreview } from "../ipc/commands";
import type { Entry, FsTarget, Preview } from "../ipc/types";
import { isDirLike } from "../lib/entries";
import { formatSize } from "../lib/fileFormat";
import { MOTION, usePresence } from "../lib/motion";
import { useLayoutStore } from "../state/layoutStore";
import { focusedEntry, usePaneStore } from "../state/paneStore";
import { useSettingsStore } from "../state/settingsStore";
import { PreviewCloseIcon, PreviewIcon } from "./icons";
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
  | { state: "ready"; path: string; preview: Preview }
  | { state: "error" };

/** Whether `entry` has file contents to read. */
function previewable(entry: Entry): boolean {
  if (isDirLike(entry)) return false;
  if (entry.kind.type === "other") return false;
  if (entry.kind.type === "symlink" && entry.kind.targetKind === null)
    return false;
  return true;
}

function targetKey(target: FsTarget | null): string {
  if (!target) return "";
  return target.kind === "remote" ? target.sessionId : "local";
}

/** Fetch the preview of `entry`, debounced, dropping stale answers. */
function usePreview(
  target: FsTarget | null,
  entry: Entry | null,
  maxBytes: number,
): Load {
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const key = targetKey(target);
  const path = entry && previewable(entry) ? entry.path : null;
  // A changed size or mtime (after a refresh) re-reads the file.
  const version = entry ? `${entry.size}:${entry.mtime}` : "";

  useEffect(() => {
    if (!target || path === null) {
      setLoad({ state: "idle" });
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    const timer = setTimeout(() => {
      fetchPreview(target, path, maxBytes).then(
        (preview) => {
          if (!cancelled) setLoad({ state: "ready", path, preview });
        },
        () => {
          if (!cancelled) setLoad({ state: "error" });
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `target` is identified by `key`; its object identity may change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path, version, maxBytes]);

  return load;
}

/** What the island shows: the last displayable preview and whose it is. */
interface Content {
  name: string;
  path: string;
  preview: Extract<Preview, { kind: "text" | "image" }>;
}

/** Whether a finished read gives something to display. */
function displayable(preview: Preview): preview is Content["preview"] {
  if (preview.kind === "text") return preview.text.length > 0;
  if (preview.kind === "image") return IMAGE_MIMES.has(preview.mime);
  return false;
}

/**
 * The content to show and whether the island is visible. Visibility only
 * changes on a definite answer: a pending read keeps what was there.
 */
function useContent(entry: Entry | null, load: Load) {
  const [content, setContent] = useState<Content | null>(null);
  const [visible, setVisible] = useState(false);
  const possible = entry !== null && previewable(entry);

  useEffect(() => {
    if (!possible) {
      setVisible(false);
      return;
    }
    if (load.state === "error") {
      setVisible(false);
    } else if (
      load.state === "ready" &&
      entry !== null &&
      load.path === entry.path
    ) {
      if (displayable(load.preview)) {
        setContent({
          name: entry.name,
          path: entry.path,
          preview: load.preview,
        });
        setVisible(true);
      } else {
        setVisible(false);
      }
    }
    // `load` answers for `entry` only when the paths match (checked above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [possible, load, entry?.path]);

  return { content, visible: visible && possible };
}

export function PreviewPanel() {
  const open = useLayoutStore((s) => s.previewOpen);
  const setOpen = useLayoutStore((s) => s.setPreviewOpen);
  const target = usePaneStore((s) => s.panes[s.active].target);
  const entry = usePaneStore((s) => focusedEntry(s.panes[s.active]));
  const maxSizeMb = useSettingsStore((s) => s.preview.maxSizeMb);
  const load = usePreview(target, entry, maxSizeMb * 1024 * 1024);
  const { content, visible } = useContent(entry, load);
  const { mounted, state } = usePresence(visible, MOTION.base);

  if (!mounted || !content) return null;

  if (!open) {
    return (
      <aside
        className={styles.collapsed}
        data-state={state}
        aria-label="Preview"
      >
        <button
          type="button"
          className={styles.tool}
          aria-label="Show preview"
          title="Show preview (Space)"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <PreviewIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className={styles.panel} data-state={state} aria-label="Preview">
      <header className={styles.header}>
        <PreviewIcon className={styles.icon} />
        <h2 className={styles.title}>Preview</h2>
        <span className={styles.subtitle} title={content.path}>
          {content.name}
        </span>
        <button
          type="button"
          className={styles.tool}
          aria-label="Hide preview"
          title="Hide preview (Space)"
          aria-expanded={true}
          onClick={() => setOpen(false)}
        >
          <PreviewCloseIcon />
        </button>
      </header>
      <div className={styles.body}>
        <PreviewBody content={content} />
      </div>
    </aside>
  );
}

function PreviewBody({ content }: { content: Content }) {
  const { preview, name } = content;
  if (preview.kind === "text") return <TextPreview preview={preview} />;
  return (
    <figure className={styles.figure}>
      <div className={styles.checker}>
        <img
          className={styles.image}
          src={`data:${preview.mime};base64,${preview.dataBase64}`}
          alt={name}
          draggable={false}
        />
      </div>
      <figcaption className={styles.caption}>
        {formatSize(preview.totalSize)}
      </figcaption>
    </figure>
  );
}

function TextPreview({
  preview,
}: {
  preview: Extract<Preview, { kind: "text" }>;
}) {
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
