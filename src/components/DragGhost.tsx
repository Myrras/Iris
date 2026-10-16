/**
 * The chip that follows the pointer while rows are dragged between the
 * panes (`lib/paneDrag`): what is dragged, and where it would go. Never
 * hit-testable (`pointer-events: none`), so the element under the pointer is
 * still the pane or row below.
 *
 * Once the pointer is outside the window the chip stays at the window edge
 * nearest to it; for remote rows it shows the download that has to finish
 * before the drag can leave the window (`lib/dragOut`).
 */

import { formatSize } from "../lib/fileFormat";
import { useDragStore, type PaneDrag } from "../state/dragStore";
import { itemCount } from "../state/paneStore";
import { DownloadIcon, UploadIcon } from "./icons";
import styles from "./DragGhost.module.css";

/** Room the chip keeps from the window edge when the pointer is outside. */
const EDGE = 8;
/** A generous chip size for keeping it inside the window. */
const CHIP_WIDTH = 220;
const CHIP_HEIGHT = 32;

export function DragGhost() {
  const drag = useDragStore((s) => s.paneDrag);
  const over = useDragStore((s) => s.over);
  if (!drag) return null;
  const upload = drag.from === "local";
  const Icon = upload ? UploadIcon : DownloadIcon;
  let x = drag.x + 14;
  let y = drag.y + 10;
  if (drag.outside) {
    x = clamp(x, EDGE, window.innerWidth - CHIP_WIDTH - EDGE);
    y = clamp(y, EDGE, window.innerHeight - CHIP_HEIGHT - EDGE);
  }
  return (
    <div
      className={styles.ghost}
      data-armed={over ? "true" : undefined}
      data-preparing={drag.preparing ? "true" : undefined}
      style={{ transform: `translate(${x}px, ${y}px)` }}
      aria-hidden
    >
      <Icon className={styles.icon} />
      <span>{label(drag, over !== null, upload)}</span>
    </div>
  );
}

function label(drag: PaneDrag, armed: boolean, upload: boolean): string {
  if (drag.preparing) {
    const { bytesDone, totalBytes } = drag.preparing;
    const pct =
      totalBytes > 0
        ? Math.min(100, Math.floor((bytesDone / totalBytes) * 100))
        : 0;
    return totalBytes > 0
      ? `Preparing ${itemCount(drag.count)}… ${pct}% of ${formatSize(totalBytes)}`
      : `Preparing ${itemCount(drag.count)}…`;
  }
  if (!armed) return itemCount(drag.count);
  return `${upload ? "Upload" : "Download"} ${itemCount(drag.count)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}
