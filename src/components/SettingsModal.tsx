/**
 * App settings dialog, tabbed like Podium's.
 *
 * - General: theme, reduced motion, hidden files, preview size cap — UI
 *   prefs from `themeStore` / `settingsStore`.
 * - Transfers: parallel transfers and reconnect attempts, from the core's
 *   `settings.json` via `backendSettingsStore` (`getSettings` /
 *   `saveSettings`).
 *
 * A new tab: add the id to `SettingsTabId`, an entry to `TABS` and a branch
 * in `TabBody`.
 */

import { useEffect, useState } from "react";

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
      return <TransfersTab />;
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
