/** Welcome content for the remote pane while no connection is open. */

import { LogoMark } from "./LogoMark";
import { ConnectIcon } from "./icons";
import styles from "./WelcomeScreen.module.css";

export function WelcomeScreen({
  onConnect,
}: {
  /**
   * Opens the connect flow. Absent until connections exist (Phase 1): the
   * button is then shown disabled, so the next step is still visible.
   */
  onConnect?: () => void;
}) {
  return (
    <div className={styles.welcome}>
      <LogoMark size={48} className={styles.logo} aria-hidden />
      <h1 className={styles.title}>Welcome to Iris</h1>
      <p className={styles.subtitle}>
        Connect to a server over SSH to browse its files side by side with your
        own.
      </p>
      <button
        type="button"
        className={styles.openBtn}
        disabled={!onConnect}
        title={onConnect ? undefined : "Connections arrive in a later version"}
        onClick={onConnect}
      >
        <ConnectIcon size={15} />
        Connect to a server…
      </button>
    </div>
  );
}
