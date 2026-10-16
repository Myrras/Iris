/**
 * The pane's "go to path" field: the breadcrumb turned into a text input with
 * the current path prefilled and selected. Enter goes there (`onSubmit`; an
 * error stays inline with the text intact), Escape or leaving the field
 * cancels. Tab completes the last segment from the listing of the folder typed
 * so far (folders only): a unique match is completed with a trailing
 * separator, several complete their common prefix and open a small list
 * (arrow keys + Enter pick one). Listings are cached while the field is open
 * and only one runs at a time.
 */

import { useEffect, useId, useRef, useState } from "react";

import { homeDir, listDir, toIpcError } from "../ipc/commands";
import type { FsTarget } from "../ipc/types";
import { isDirLike } from "../lib/entries";
import {
  completeSegment,
  completionFolder,
  goToErrorMessage,
  pickSuggestion,
  splitForCompletion,
  usesHome,
} from "../lib/goToPath";
import type { GoToResult } from "../state/paneStore";
import styles from "./GoToField.module.css";

interface FolderName {
  name: string;
  hidden: boolean;
}

export function GoToField({
  target,
  cwd,
  windows,
  onSubmit,
  onClose,
}: {
  target: FsTarget;
  /** The folder on screen: the prefill, and where relative paths start. */
  cwd: string;
  /** Local path on Windows. */
  windows: boolean;
  /** Go there; resolves `ok` when the pane moved (the parent then closes). */
  onSubmit: (text: string) => Promise<GoToResult>;
  /** Leave the field; `refocus` = hand the focus back to the file table. */
  onClose: (refocus: boolean) => void;
}) {
  const [text, setText] = useState(cwd);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  const mounted = useRef(true);
  /** Folder names by listed folder, for as long as the field is open. */
  const cache = useRef(new Map<string, FolderName[]>());
  const home = useRef<string | null>(null);
  /** At most one listing request at a time. */
  const listing = useRef(false);
  const ids = useId();
  const listId = `${ids}-list`;
  const errorId = `${ids}-error`;

  useEffect(() => {
    mounted.current = true;
    input.current?.focus();
    input.current?.select();
    return () => {
      mounted.current = false;
    };
  }, []);

  const change = (next: string) => {
    textRef.current = next;
    setText(next);
    setError(null);
    setSuggestions([]);
    setActive(-1);
  };

  async function foldersFor(
    head: string,
  ): Promise<{ folders: FolderName[] } | null> {
    if (usesHome(head, windows) && home.current === null) {
      home.current = await homeDir(target);
    }
    const folder = completionFolder(head, {
      cwd,
      home: home.current,
      windows,
    });
    if (folder === null) return null;
    const cached = cache.current.get(folder);
    if (cached) return { folders: cached };
    const folders = (await listDir(target, folder))
      .filter(isDirLike)
      .map((e) => ({ name: e.name, hidden: e.hidden }));
    cache.current.set(folder, folders);
    return { folders };
  }

  async function complete() {
    if (listing.current || busy) return;
    const asked = textRef.current;
    const split = splitForCompletion(asked, windows);
    if (!split) return;
    listing.current = true;
    try {
      const found = await foldersFor(split.head);
      // Typed on, or left, while the folder was being listed.
      if (!found || !mounted.current || textRef.current !== asked) return;
      // Hidden folders only when asked for with a leading dot, like a shell.
      const names = found.folders
        .filter((f) => !f.hidden || split.prefix.startsWith("."))
        .map((f) => f.name);
      const done = completeSegment(split, names, windows);
      if (!done) return;
      textRef.current = done.text;
      setText(done.text);
      setSuggestions(done.suggestions);
      setActive(-1);
    } catch (e) {
      if (!mounted.current) return;
      const err = toIpcError(e);
      setError(goToErrorMessage(err.kind, err.message));
    } finally {
      listing.current = false;
    }
  }

  function pick(index: number) {
    const split = splitForCompletion(textRef.current, windows);
    const name = suggestions[index];
    if (!split || name === undefined) return;
    change(pickSuggestion(split, name, windows));
    input.current?.focus();
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    const result = await onSubmit(textRef.current);
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) setError(result.message);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) pick(active);
      else void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose(true);
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      void complete();
    } else if (
      (e.key === "ArrowDown" || e.key === "ArrowUp") &&
      suggestions.length > 0
    ) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
    }
  }

  return (
    <div className={styles.field}>
      <input
        ref={input}
        type="text"
        className={styles.input}
        aria-label="Go to path"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-controls={suggestions.length > 0 ? listId : undefined}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        value={text}
        readOnly={busy}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (busy) return;
          // The whole window lost focus (switching apps to copy a path):
          // the field keeps the text until it is back.
          if (
            !document.hasFocus() &&
            document.activeElement === e.currentTarget
          )
            return;
          onClose(false);
        }}
      />
      {error ? (
        <div id={errorId} className={styles.error} role="alert">
          {error}
        </div>
      ) : (
        suggestions.length > 0 && (
          <ul
            id={listId}
            className={styles.list}
            role="listbox"
            aria-label="Folders"
            // Keep the focus in the field: a blur would cancel it.
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((name, i) => (
              <li
                key={name}
                id={`${listId}-${i}`}
                className={styles.option}
                role="option"
                aria-selected={i === active}
                onClick={() => pick(i)}
              >
                {name}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
