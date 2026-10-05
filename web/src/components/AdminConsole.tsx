import { useState, type ReactElement } from "react";

import type { AdminTab } from "../lib/session.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { AdminPanel } from "./AdminPanel.tsx";
import { Avatar } from "./Avatar.tsx";
import {
  IconChannels,
  IconChart,
  IconChats,
  IconClose,
  IconFile,
  IconSearch,
  IconShield,
  IconUsers,
} from "./Icons.tsx";

const TABS: { id: AdminTab; icon: () => ReactElement }[] = [
  { id: "overview", icon: () => <IconChart width={16} height={16} /> },
  { id: "users", icon: () => <IconUsers width={16} height={16} /> },
  { id: "channels", icon: () => <IconChannels width={16} height={16} /> },
  { id: "security", icon: () => <IconShield width={16} height={16} /> },
  { id: "pages", icon: () => <IconFile width={16} height={16} /> },
];

/**
 * The administration console: its own URL, its own chrome, its own audience.
 *
 * It used to be a tab inside the messenger, which put a chat rail and an unread
 * badge over a server dashboard — two products wearing one set of clothes. It
 * lives at /admin now and looks like what it is.
 *
 * One deliberate consequence of the separation: the console works with the
 * vault still locked. It never touches a key, because there is nothing here to
 * decrypt — an operator checking whether the disk is filling up should not have
 * to type the passphrase that guards their conversations.
 */
export function AdminConsole({ tab }: { tab: AdminTab }) {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");

  if (state.phase === "loading") {
    return (
      <div className="splash">
        <img src="/brand/icon-192.png" alt="" width={72} height={72} />
        <p>{t("app.loading")}</p>
      </div>
    );
  }

  // No session at all, or a session that is not an administrator's. Both get
  // the same page: saying which one it is would tell an unauthenticated
  // visitor whether a given account exists and holds the keys to the server.
  if (!state.user?.isAdmin) {
    return (
      <div className="adm adm--gate">
        <div className="adm__gateCard">
          <img src="/brand/icon-192.png" alt="" width={56} height={56} />
          <h1>{t("admin.title")}</h1>
          <p>{t("admin.noAccess")}</p>
          <button className="btn btn--primary" onClick={() => session.navigate("/")}>
            {t("admin.backToApp")}
          </button>
        </div>
      </div>
    );
  }

  const user = state.user;

  return (
    <div className={`adm${menuOpen ? " adm--menu" : ""}`}>
      <aside className="adm__side">
        <div className="adm__brand">
          <img src="/brand/icon-192.png" alt="" width={26} height={26} />
          <strong>Kivora</strong>
          <button
            className="adm__burger"
            onClick={() => setMenuOpen((v) => !v)}
            title={t("admin.toggleMenu")}
          >
            <span />
            <span />
            <span />
          </button>
        </div>

        <p className="adm__section">{t("admin.navSection")}</p>
        <nav className="adm__nav">
          {TABS.map(({ id, icon }) => (
            <button
              key={id}
              className={tab === id ? "on" : ""}
              onClick={() => {
                session.openAdmin(id);
                setMenuOpen(false);
              }}
            >
              {icon()}
              {t(`admin.${id}` as never)}
            </button>
          ))}
        </nav>

        <p className="adm__section">{t("admin.appSection")}</p>
        <nav className="adm__nav">
          <button onClick={() => session.navigate("/")}>
            <IconChats width={16} height={16} />
            {t("admin.backToApp")}
          </button>
        </nav>

        <p className="adm__foot">
          {state.server?.name} {state.server?.version}
        </p>
      </aside>

      <div className="adm__main">
        <header className="adm__bar">
          <label className="adm__search">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("admin.searchPlaceholder")}
              aria-label={t("admin.searchPlaceholder")}
            />
            {query && (
              <button onClick={() => setQuery("")} title={t("media.close")}>
                <IconClose width={14} height={14} />
              </button>
            )}
            <span className="adm__searchGo">
              <IconSearch width={15} height={15} />
            </span>
          </label>

          <div className="adm__who">
            <Avatar name={user.displayName} hue={user.avatarHue} avatar={user.avatar} size={32} />
            <span>
              {user.displayName}
              <em>{t("admin.roleAdmin")}</em>
            </span>
          </div>
        </header>

        <div className="adm__crumbs">
          <h1>{t(`admin.${tab}` as never)}</h1>
          <p>
            <button onClick={() => session.openAdmin("overview")}>{t("admin.title")}</button>
            <span>/</span>
            {t(`admin.${tab}` as never)}
          </p>
        </div>

        <div className="adm__body">
          <AdminPanel tab={tab} query={query} />
        </div>
      </div>
    </div>
  );
}
