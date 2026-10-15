/**
 * Application shell.
 *
 * A minimal, self-contained demo of the whole stack: a greet form that calls a
 * pure core command, and a notes list backed by the core's state through the
 * `notesStore`. Replace this with your real UI — the wiring (typed IPC, a
 * Zustand store mirroring the backend, token-driven styling, a theme toggle) is
 * the part worth keeping.
 */

import { useEffect, useState } from "react";

import { greet, toIpcError } from "./ipc/commands";
import { useNotesStore } from "./state/notesStore";
import { useThemeStore } from "./state/themeStore";
import styles from "./App.module.css";

export default function App() {
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState("");
  const [greetError, setGreetError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const themeMode = useThemeStore((s) => s.mode);
  const toggleTheme = useThemeStore((s) => s.toggle);

  const notes = useNotesStore((s) => s.notes);
  const notesError = useNotesStore((s) => s.lastError);
  const refreshNotes = useNotesStore((s) => s.refresh);
  const addNote = useNotesStore((s) => s.add);
  const removeNote = useNotesStore((s) => s.remove);

  useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

  async function onGreet(e: React.FormEvent) {
    e.preventDefault();
    try {
      setGreeting(await greet(name));
      setGreetError(null);
    } catch (err) {
      setGreetError(toIpcError(err).message);
      setGreeting("");
    }
  }

  async function onAddNote(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    await addNote(draft);
    setDraft("");
  }

  return (
    <div className={styles.app}>
      <header className={styles.titlebar}>
        <div className={styles.brand}>
          <span className={styles.product}>Iris</span>
          <span className={styles.tagline}>remote file manager</span>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {themeMode === "dark" ? "Light" : "Dark"} theme
        </button>
      </header>

      <main className={styles.body}>
        <section className={styles.card}>
          <h2 className={styles.heading}>Greet (pure core command)</h2>
          <form className={styles.row} onSubmit={onGreet}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
            />
            <button type="submit" className="primary">
              Greet
            </button>
          </form>
          {greeting && <p className={styles.result}>{greeting}</p>}
          {greetError && <p className={styles.error}>{greetError}</p>}
        </section>

        <section className={styles.card}>
          <h2 className={styles.heading}>Notes (core state via store)</h2>
          <form className={styles.row} onSubmit={onAddNote}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a note…"
              aria-label="Add a note"
            />
            <button type="submit" className="primary">
              Add
            </button>
          </form>
          {notesError && <p className={styles.error}>{notesError.message}</p>}
          {notes.length === 0 ? (
            <p className={styles.empty}>No notes yet.</p>
          ) : (
            <ul className={styles.notes}>
              {notes.map((note) => (
                <li key={note.id} className={styles.note}>
                  <span>{note.text}</span>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void removeNote(note.id)}
                    aria-label={`Remove ${note.text}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
