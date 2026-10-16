/**
 * The preview island right of the panes (Quick Look-style; Space or the pane
 * toolbar toggles it). It follows the focused entry of the active pane: text
 * in monospace (the start only for large files, with a notice), images fitted
 * on a checkerboard, and a short note for folders, binary files and images
 * over the size limit. Collapsed, it is a slim strip with an expand button;
 * the state persists in `layoutStore`.
 *
 * SVG arrives as an image and is only ever shown through an `<img>` data URL,
 * which cannot run scripts; preview markup is never injected into the page.
 */

import { useEffect, useState } from "react";

import { preview as fetchPreview, toIpcError } from "../ipc/commands";
import type { Entry, FsTarget, Preview } from "../ipc/types";
import { isDirLike } from "../lib/entries";
import { formatSize } from "../lib/fileFormat";
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
  const setOpen = useLayoutStore((s) => s.setPreviewOpen);
  const target = usePaneStore((s) => s.panes[s.active].target);
  const entry = usePaneStore((s) => focusedEntry(s.panes[s.active]));
  const maxSizeMb = useSettingsStore((s) => s.preview.maxSizeMb);
  const load = usePreview(target, entry, maxSizeMb * 1024 * 1024, open);

  if (!open) {
    return (
      <aside className={styles.collapsed} aria-label="Preview">
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
          title="Hide preview (Space)"
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
