/**
 * Get Info / Permissions: what the selected entries are, and their unix
 * permissions as a read/write/execute grid kept in step with an octal field
 * (either edits the other). Folders can apply the mode to everything inside.
 */

import { useEffect, useId, useRef, useState } from "react";

import type { Entry } from "../ipc/types";
import { formatModifiedFull } from "../lib/dateFormat";
import { isDirLike } from "../lib/entries";
import { formatPermissions, formatSize } from "../lib/fileFormat";
import {
  WHAT,
  WHO,
  formatOctalMode,
  parseOctalMode,
  permissionBit,
  withPermission,
} from "../lib/mode";
import { itemCount } from "../state/paneStore";
import { Modal } from "./Modal";
import styles from "./ChmodDialog.module.css";

export interface ChmodRequest {
  entries: Entry[];
}

const WHO_LABEL = { owner: "Owner", group: "Group", other: "Others" };
const WHAT_LABEL = { read: "Read", write: "Write", execute: "Execute" };

function kindLabel(entry: Entry): string {
  switch (entry.kind.type) {
    case "dir":
      return "Folder";
    case "file":
      return "File";
    case "other":
      return "Special file";
    case "symlink":
      return entry.kind.targetKind === null
        ? "Broken link"
        : `Link to ${entry.kind.target ?? "?"}`;
  }
}

export function ChmodDialog({
  request,
  onApply,
  onClose,
}: {
  request: ChmodRequest | null;
  onApply: (mode: number, recursive: boolean) => void;
  onClose: () => void;
}) {
  // Keep the last request mounted while the dialog animates out.
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  const formId = useId();
  const [valid, setValid] = useState(true);
  if (!shown) return null;

  return (
    <Modal
      open={request !== null}
      title={
        shown.entries.length === 1
          ? `${shown.entries[0].name} Info`
          : `${itemCount(shown.entries.length)} Info`
      }
      onClose={onClose}
      width={420}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="primary"
            disabled={!valid}
          >
            Apply
          </button>
        </>
      }
    >
      {/* Keyed by the request so each opening starts from the entries' modes. */}
      <ChmodForm
        key={shown.entries.map((e) => e.path).join("\0")}
        id={formId}
        entries={shown.entries}
        onApply={onApply}
        onValidChange={setValid}
      />
    </Modal>
  );
}

function ChmodForm({
  id,
  entries,
  onApply,
  onValidChange,
}: {
  id: string;
  entries: Entry[];
  onApply: (mode: number, recursive: boolean) => void;
  onValidChange: (valid: boolean) => void;
}) {
  const modes = entries
    .map((e) => e.mode)
    .filter((m): m is number => m !== null)
    .map((m) => m & 0o7777);
  const mixed = new Set(modes).size > 1;
  const initial = modes[0] ?? 0o644;

  const [mode, setMode] = useState(initial);
  const [octal, setOctal] = useState(formatOctalMode(initial));
  const [recursive, setRecursive] = useState(false);
  const octalValid = parseOctalMode(octal) !== null;
  const hasFolders = entries.some((e) => e.kind.type === "dir");
  const single = entries.length === 1 ? entries[0] : null;
  const errorId = `${id}-octal-error`;

  // Without any known mode (a Windows disk) there is nothing to edit.
  const editable = modes.length > 0;
  useEffect(
    () => onValidChange(editable && octalValid),
    [editable, octalValid, onValidChange],
  );

  function setFromGrid(next: number) {
    setMode(next);
    setOctal(formatOctalMode(next));
  }

  function setFromText(text: string) {
    setOctal(text);
    const parsed = parseOctalMode(text);
    if (parsed !== null) setMode(parsed);
  }

  return (
    <form
      id={id}
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (editable && octalValid) onApply(mode, hasFolders && recursive);
      }}
    >
      {single ? (
        <dl className={styles.info}>
          <dt>Kind</dt>
          <dd>{kindLabel(single)}</dd>
          {!isDirLike(single) && (
            <>
              <dt>Size</dt>
              <dd>{formatSize(single.size)}</dd>
            </>
          )}
          <dt>Modified</dt>
          <dd>{formatModifiedFull(single.mtime) || "Unknown"}</dd>
          <dt>Where</dt>
          <dd className={styles.path} title={single.path}>
            {single.path}
          </dd>
        </dl>
      ) : (
        <p className={styles.lead}>{itemCount(entries.length)} selected.</p>
      )}

      {!editable ? (
        <div className={styles.section}>
          <h3 className={styles.heading}>Permissions</h3>
          <p className={styles.current}>
            Unix permissions are not available here.
          </p>
        </div>
      ) : (
        <div className={styles.section}>
          <h3 className={styles.heading}>Permissions</h3>
          <p className={styles.current}>
            Current:{" "}
            {mixed ? (
              "mixed"
            ) : (
              <code>
                {formatPermissions(initial).slice(1)} (
                {formatOctalMode(initial)})
              </code>
            )}
          </p>
          <table className={styles.grid}>
            <thead>
              <tr>
                <th />
                {WHAT.map((what) => (
                  <th key={what} scope="col">
                    {WHAT_LABEL[what]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WHO.map((who) => (
                <tr key={who}>
                  <th scope="row">{WHO_LABEL[who]}</th>
                  {WHAT.map((what) => (
                    <td key={what}>
                      <input
                        type="checkbox"
                        aria-label={`${WHO_LABEL[who]} ${WHAT_LABEL[what].toLowerCase()}`}
                        checked={(mode & permissionBit(who, what)) !== 0}
                        onChange={(e) =>
                          setFromGrid(
                            withPermission(mode, who, what, e.target.checked),
                          )
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <div className={styles.octalRow}>
            <label htmlFor={`${id}-octal`} className={styles.octalLabel}>
              Octal
            </label>
            <input
              id={`${id}-octal`}
              className={styles.octal}
              value={octal}
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!octalValid}
              aria-describedby={octalValid ? undefined : errorId}
              onChange={(e) => setFromText(e.target.value)}
            />
          </div>
          {!octalValid && (
            <p id={errorId} className={styles.error} role="alert">
              Enter 3 or 4 octal digits (0–7), e.g. 755.
            </p>
          )}

          {hasFolders && (
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
              />
              <span>
                Apply to everything inside
                <small>
                  Changes all files and folders in{" "}
                  {entries.length === 1 ? "this folder" : "these folders"}{" "}
                  (links are skipped).
                </small>
              </span>
            </label>
          )}
        </div>
      )}
    </form>
  );
}
