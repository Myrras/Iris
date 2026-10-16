/**
 * App settings dialog, tabbed like Podium's.
 *
 * - General: theme, reduced motion, hidden files, preview size cap — UI
 *   prefs from `themeStore` / `settingsStore`.
 * - Transfers: parallel transfers and reconnect attempts, from the core's
 *   `settings.json` via `backendSettingsStore` (`getSettings` /
 *   `saveSettings`), and the names a sync leaves alone (`syncExcludes`,
 *   cards in Podium's look; `lib/syncExcludes`).
 * - Editors: which application opens a remote file for editing, per
 *   extension (`editorOverrides` in the same `settings.json`); rows in
 *   Podium's card look, the app picked with the native dialog.
 *
 * A new tab: add the id to `SettingsTabId`, an entry to `TABS` and a branch
 * in `TabBody`.
 */

import { useEffect, useState } from "react";

import { toIpcError } from "../ipc/commands";
import {
  appName,
  normalizeExtension,
  overrideError,
  withOverride,
  withoutOverride,
} from "../lib/editorOverrides";
import { isMac, isWindows } from "../lib/platform";
import {
  DEFAULT_SYNC_EXCLUDES,
  excludeError,
  isDefaultExcludes,
  withExclude,
  withoutExclude,
} from "../lib/syncExcludes";

import { Modal } from "./Modal";
import {
  PARALLEL_TRANSFERS_MAX,
  PARALLEL_TRANSFERS_MIN,
  RECONNECT_ATTEMPTS_MAX,
  RECONNECT_ATTEMPTS_MIN,
  useBackendSettingsStore,
} from "../state/backendSettingsStore";
import { useThemeStore, type ThemeMode } from "../state/themeStore";
import {
  PREVIEW_MAX_SIZE_MAX_MB,
  PREVIEW_MAX_SIZE_MIN_MB,
  useSettingsStore,
} from "../state/settingsStore";
import {
  useSettingsRequestStore,
  type SettingsTabId,
} from "../state/settingsRequestStore";
import { AddIcon, CheckIcon, MinusIcon } from "./icons";
import styles from "./SettingsModal.module.css";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const TABS: [SettingsTabId, string][] = [
  ["general", "General"],
  ["transfers", "Transfers"],
  ["editors", "Editors"],
];

/**
 * Each theme's background / accent / text, as fixed preview tokens
 * (`--swatch-*` in tokens.css) — the picker shows every theme at once, so it
 * cannot use the live palette tokens.
 */
const THEMES: {
  mode: ThemeMode;
  label: string;
  swatches: [string, string, string];
}[] = [
  {
    mode: "dark",
    label: "Dark",
    swatches: [
      "var(--swatch-dark-bg)",
      "var(--swatch-dark-accent)",
      "var(--swatch-dark-text)",
    ],
  },
  {
    mode: "light",
    label: "Light",
    swatches: [
      "var(--swatch-light-bg)",
      "var(--swatch-light-accent)",
      "var(--swatch-light-text)",
    ],
  },
  {
    mode: "retro",
    label: "Retro",
    swatches: [
      "var(--swatch-retro-bg)",
      "var(--swatch-retro-accent)",
      "var(--swatch-retro-text)",
    ],
  },
];

/** Checkbox toggle row with label and optional helper text. */
function SettingToggle({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>
        {label}
        {help && <small className={styles.rowHelp}>{help}</small>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        className={styles.toggle}
        data-on={value ? "true" : "false"}
        onClick={() => onChange(!value)}
        aria-label={label}
      />
    </div>
  );
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTabId>("general");
  const requestedTab = useSettingsRequestStore((s) => s.request);
  useEffect(() => {
    if (open && requestedTab) setTab(requestedTab);
  }, [open, requestedTab]);

  return (
    <Modal open={open} title="Settings" onClose={onClose} width={520}>
      {/* Tabs */}
      <div className={styles.tabs} role="tablist" aria-label="Settings tabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={styles.tab}
            data-active={tab === id ? "true" : "false"}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <TabBody tab={tab} />
    </Modal>
  );
}

function TabBody({ tab }: { tab: SettingsTabId }) {
  switch (tab) {
    case "general":
      return <GeneralTab />;
    case "transfers":
      return (
        <>
          <TransfersTab />
          <SyncExcludes />
        </>
      );
    case "editors":
      return <EditorsTab />;
  }
}

/** A − value + control for a bounded whole number (`label` names it). */
function Stepper({
  label,
  value,
  min,
  max,
  show = String,
  onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  show?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className={styles.stepper}>
      <button
        type="button"
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={value === null || value <= min}
        onClick={() => value !== null && onChange(value - 1)}
      >
        <MinusIcon size={14} />
      </button>
      <span className={styles.stepperValue} aria-label={label}>
        {value === null ? "–" : show(value)}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={value === null || value >= max}
        onClick={() => value !== null && onChange(value + 1)}
      >
        <AddIcon size={14} />
      </button>
    </div>
  );
}

function TransfersTab() {
  const settings = useBackendSettingsStore((s) => s.settings);
  const save = useBackendSettingsStore((s) => s.save);
  useEffect(() => {
    void useBackendSettingsStore.getState().load();
  }, []);

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionLabel}>Transfers</h3>
      <div className={styles.row}>
        <span className={styles.rowLabel}>
          Parallel transfers
          <small className={styles.rowHelp}>
            How many files copy at once. A change applies to the next file that
            starts.
          </small>
        </span>
        <Stepper
          label="Parallel transfers"
          value={settings?.parallelTransfers ?? null}
          min={PARALLEL_TRANSFERS_MIN}
          max={PARALLEL_TRANSFERS_MAX}
          onChange={(n) => void save({ parallelTransfers: n })}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>
          Reconnect attempts
          <small className={styles.rowHelp}>
            How often a dropped connection is retried (after 1, 2, 4, 8, then
            every 16 seconds) before Iris gives up. Paused transfers continue
            once it is back. 0 = never reconnect.
          </small>
        </span>
        <Stepper
          label="Reconnect attempts"
          value={settings?.reconnectAttempts ?? null}
          min={RECONNECT_ATTEMPTS_MIN}
          max={RECONNECT_ATTEMPTS_MAX}
          show={(n) => (n === 0 ? "Off" : String(n))}
          onChange={(n) => void save({ reconnectAttempts: n })}
        />
      </div>
    </section>
  );
}

function SyncExcludes() {
  const settings = useBackendSettingsStore((s) => s.settings);
  const save = useBackendSettingsStore((s) => s.save);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = settings?.syncExcludes ?? [];

  const add = () => {
    const problem = excludeError(draft, list);
    if (problem) {
      setError(problem);
      return;
    }
    setDraft("");
    setError(null);
    void save({ syncExcludes: withExclude(list, draft) });
  };

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionLabel}>Sync excludes</h3>
      <small className={styles.rowHelp}>
        Names a sync never copies or deletes, wherever they are in the folder.
        Use * for any characters and ? for one, e.g. *.log.
      </small>
      {settings && list.length === 0 && (
        <p className={styles.empty}>
          Nothing is excluded: a sync takes everything.
        </p>
      )}
      {list.map((pattern) => (
        <div key={pattern} className={`${styles.card} ${styles.cardCompact}`}>
          <div className={styles.cardHeader}>
            <span className={styles.cardName}>{pattern}</span>
            <div className={`${styles.cardActions} ${styles.pushRight}`}>
              <button
                type="button"
                aria-label={`Remove the sync exclude ${pattern}`}
                onClick={() =>
                  void save({ syncExcludes: withoutExclude(list, pattern) })
                }
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ))}
      <form
        className={styles.fieldRow}
        aria-label="New sync exclude"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          type="text"
          value={draft}
          placeholder="*.tmp"
          aria-label="Name or pattern to exclude"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={!settings}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" disabled={!settings}>
          Add
        </button>
      </form>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {settings && !isDefaultExcludes(list) && (
        <div className={styles.editActions}>
          <button
            type="button"
            onClick={() => {
              setError(null);
              void save({ syncExcludes: [...DEFAULT_SYNC_EXCLUDES] });
            }}
          >
            Restore defaults
          </button>
        </div>
      )}
    </section>
  );
}

/** The row being added (`original` null) or edited. */
interface EditorDraft {
  original: string | null;
  ext: string;
  app: string;
}

/** Native picker for an application: `.app` bundles on macOS, `.exe` on Windows. */
async function pickApplication(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    title: "Choose an application",
    defaultPath: isMac ? "/Applications" : undefined,
    filters: isMac
      ? [{ name: "Applications", extensions: ["app"] }]
      : isWindows
        ? [{ name: "Programs", extensions: ["exe"] }]
        : undefined,
  });
  return typeof picked === "string" ? picked : null;
}

function EditorsTab() {
  const settings = useBackendSettingsStore((s) => s.settings);
  const save = useBackendSettingsStore((s) => s.save);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void useBackendSettingsStore.getState().load();
  }, []);

  const overrides = settings?.editorOverrides ?? {};
  const rows = Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b));

  const edit = (next: EditorDraft | null) => {
    setDraft(next);
    setError(null);
  };
  const choose = async () => {
    if (!draft) return;
    try {
      const app = await pickApplication();
      if (app) setDraft({ ...draft, app });
    } catch (e) {
      setError(toIpcError(e).message);
    }
  };
  const submit = () => {
    if (!draft) return;
    const ext = normalizeExtension(draft.ext);
    const problem = overrideError(ext, draft.app, overrides, draft.original);
    if (problem) {
      setError(problem);
      return;
    }
    edit(null);
    void save({
      editorOverrides: withOverride(overrides, ext, draft.app, draft.original),
    });
  };

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionLabel}>Editors</h3>
      <small className={styles.rowHelp}>
        Remote files open in the application set for their extension, else in
        your system&apos;s default app. Every save is uploaded back.
      </small>
      {settings && rows.length === 0 && !draft && (
        <p className={styles.empty}>
          No editors set: every file opens in its default app.
        </p>
      )}
      {rows.map(([ext, app]) => (
        <div key={ext} className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.cardName}>.{ext}</span>
            <span className={styles.cardDetail} title={app}>
              {appName(app)}
            </span>
            <div className={`${styles.cardActions} ${styles.pushRight}`}>
              <button
                type="button"
                aria-label={`Edit the .${ext} editor`}
                onClick={() => edit({ original: ext, ext, app })}
              >
                Edit
              </button>
              <button
                type="button"
                aria-label={`Remove the .${ext} editor`}
                onClick={() =>
                  void save({
                    editorOverrides: withoutOverride(overrides, ext),
                  })
                }
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ))}
      {draft ? (
        <form
          className={styles.card}
          aria-label={draft.original ? "Edit editor" : "New editor"}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <span className={styles.cardName}>
            {draft.original ? `Edit .${draft.original}` : "New editor"}
          </span>
          <div className={styles.field}>
            <label htmlFor="editor-ext">Extension</label>
            <input
              id="editor-ext"
              type="text"
              value={draft.ext}
              placeholder="md"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, ext: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="editor-app">Application</label>
            <div className={styles.fieldRow}>
              <input
                id="editor-app"
                type="text"
                readOnly
                value={draft.app}
                placeholder="Not chosen"
                title={draft.app}
              />
              <button type="button" onClick={() => void choose()}>
                Choose…
              </button>
            </div>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.editActions}>
            <button type="button" onClick={() => edit(null)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Save
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.editActions}>
          <button
            type="button"
            disabled={!settings}
            onClick={() => edit({ original: null, ext: "", app: "" })}
          >
            Add editor
          </button>
        </div>
      )}
    </section>
  );
}

function GeneralTab() {
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useThemeStore((s) => s.setTheme);
  const settings = useSettingsStore();
  const maxSizeMb = settings.preview.maxSizeMb;

  return (
    <>
      {/* Appearance */}
      <section className={styles.section}>
        <h3 className={styles.sectionLabel}>Appearance</h3>
        <div className={styles.themeOptions}>
          {THEMES.map(({ mode: m, label, swatches }) => (
            <button
              key={m}
              type="button"
              className={`${styles.themeOption} ${mode === m ? styles.active : ""}`}
              onClick={() => setTheme(m)}
              aria-pressed={mode === m}
            >
              <span className={styles.swatch}>
                {swatches.map((color, i) => (
                  <span
                    key={i}
                    className={styles.swatchSegment}
                    style={{ background: color }}
                  />
                ))}
              </span>
              <span className={styles.themeLabel}>{label}</span>
              {mode === m && (
                <span className={styles.check} aria-hidden>
                  <CheckIcon />
                </span>
              )}
            </button>
          ))}
        </div>
        <SettingToggle
          label="Reduce motion"
          help="Disable app animations. Your OS reduced-motion preference still applies regardless."
          value={settings.appearance.reduceMotion}
          onChange={(v) => settings.set("appearance", { reduceMotion: v })}
        />
      </section>

      {/* Files */}
      <section className={styles.section}>
        <h3 className={styles.sectionLabel}>Files</h3>
        <SettingToggle
          label="Show hidden files"
          help="List dotfiles and other hidden entries in both panes."
          value={settings.browser.showHidden}
          onChange={(v) => settings.set("browser", { showHidden: v })}
        />
        <div className={styles.row}>
          <span className={styles.rowLabel}>
            Preview size limit
            <small className={styles.rowHelp}>
              Larger files are not previewed inline.
            </small>
          </span>
          <div className={styles.stepper}>
            <button
              type="button"
              aria-label="Decrease preview size limit"
              disabled={maxSizeMb <= PREVIEW_MAX_SIZE_MIN_MB}
              onClick={() =>
                settings.set("preview", { maxSizeMb: maxSizeMb - 1 })
              }
            >
              <MinusIcon size={14} />
            </button>
            <span className={styles.stepperValue}>{maxSizeMb} MB</span>
            <button
              type="button"
              aria-label="Increase preview size limit"
              disabled={maxSizeMb >= PREVIEW_MAX_SIZE_MAX_MB}
              onClick={() =>
                settings.set("preview", { maxSizeMb: maxSizeMb + 1 })
              }
            >
              <AddIcon size={14} />
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
