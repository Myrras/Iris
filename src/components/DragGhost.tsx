/**
 * The chip that follows the pointer while rows are dragged between the
 * panes (`lib/paneDrag`): what is dragged, and where it would go. Never
 * hit-testable (`pointer-events: none`), so the element under the pointer is
 * still the pane or row below.
 */

import { itemCount } from "../state/paneStore";
import { useDragStore } from "../state/dragStore";
import { DownloadIcon, UploadIcon } from "./icons";
import styles from "./DragGhost.module.css";

export function DragGhost() {
  const drag = useDragStore((s) => s.paneDrag);
  const over = useDragStore((s) => s.over);
  if (!drag) return null;
  const upload = drag.from === "local";
  const Icon = upload ? UploadIcon : DownloadIcon;
  return (
    <div
      className={styles.ghost}
      data-armed={over ? "true" : undefined}
      style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 10}px)` }}
      aria-hidden
    >
      <Icon className={styles.icon} />
      <span>
        {over
          ? `${upload ? "Upload" : "Download"} ${itemCount(drag.count)}`
          : itemCount(drag.count)}
      </span>
    </div>
  );
}
