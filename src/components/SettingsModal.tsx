/**
 * App settings dialog, tabbed like Podium's. Phase 0 ships the General tab
 * (theme, reduced motion, hidden files, preview size cap — all UI prefs from
 * `themeStore` / `settingsStore`). Transfers and Editors tabs, backed by the
 * core's `settings.json` (`getSettings` / `saveSettings`), join it later: add
 * the id to `SettingsTabId`, an entry to `TABS` and a branch in `TabBody`.
 */

import { useEffect, useState } from "react";

import { Modal } from "./Modal";
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

const TABS: [SettingsTabId, string][] = [["general", "General"]];

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
  }
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
