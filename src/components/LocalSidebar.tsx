/**
 * The sidebar's Local section, above Connections: always "Home" (the local
 * home folder; it cannot be removed or renamed), then the Local favorites
 * (app-wide, kept in the core's settings). A click opens the folder in the
 * active Local tab, ⌘-click (Ctrl-click off macOS) in a new one; see
 * `FavoriteList` for the favorites' menu and reordering.
 */

import { useEffect, useState } from "react";

import { homeDir } from "../ipc/commands";
import {
  LOCAL_FAVORITES,
  openLocalFavorite,
  openLocalHome,
  useFavorites,
  wantsNewTab,
} from "../lib/favorites";
import { useBackendSettingsStore } from "../state/backendSettingsStore";
import { ContextMenu } from "./ContextMenu";
import { FavoriteList } from "./FavoriteList";
import { SectionTitle } from "./SectionTitle";
import { HomeIcon, LocalIcon } from "./icons";
import rowStyles from "./ConnectionRow.module.css";
import favStyles from "./FavoriteList.module.css";
import styles from "./Sidebar.module.css";

export function LocalSidebar() {
  const favorites = useFavorites(LOCAL_FAVORITES);
  const [collapsed, setCollapsed] = useState(false);
  const [home, setHome] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // The favorites live in the core's settings; nothing else loads them
    // before the Settings dialog opens.
    if (!useBackendSettingsStore.getState().settings) {
      void useBackendSettingsStore.getState().load();
    }
    let live = true;
    homeDir({ kind: "local" })
      .then((path) => live && setHome(path))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className={styles.subsection}>
      <div className={styles.sectionHeader}>
        <SectionTitle
          title="Local"
          Icon={LocalIcon}
          count={favorites.length + 1}
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
        />
      </div>
      <div
        className={`${styles.sectionBody}${collapsed ? ` ${styles.sectionBodyCollapsed}` : ""}`}
      >
        <div className={styles.sectionBodyInner}>
          <div className={styles.list}>
            <div
              className={`${rowStyles.row} ${favStyles.row}`}
              role="button"
              tabIndex={0}
              title={home ?? "Home folder"}
              onClick={(e) => void openLocalHome(wantsNewTab(e))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void openLocalHome(wantsNewTab(e));
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              <HomeIcon size={12} className={favStyles.homeIcon} />
              <span className={rowStyles.name}>Home</span>
            </div>
            {favorites.length > 0 && (
              <FavoriteList
                scope={LOCAL_FAVORITES}
                favorites={favorites}
                label="Local favorites"
                onOpen={(fav, newTab) => openLocalFavorite(fav.path, newTab)}
              />
            )}
          </div>
        </div>
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={[
          { label: "Open", onSelect: () => void openLocalHome(false) },
          {
            label: "Open in New Tab",
            onSelect: () => void openLocalHome(true),
          },
        ]}
        onClose={() => setMenu(null)}
      />
    </section>
  );
}
