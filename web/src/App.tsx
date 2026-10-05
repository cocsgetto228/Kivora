import { useEffect, useState, type ReactNode } from "react";

import { useSession, useSessionState } from "./state/useSession.ts";
import { useT } from "./i18n/useT.ts";
import { AdminConsole } from "./components/AdminConsole.tsx";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { CallOverlay, IncomingCall } from "./components/CallOverlay.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { ComposeDialog } from "./components/ComposeDialog.tsx";
import { NotFound } from "./components/NotFound.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { Sidebar, type Section } from "./components/Sidebar.tsx";
import { Avatar } from "./components/Avatar.tsx";
import {
  IconArchive,
  IconChannels,
  IconChats,
  IconClose,
  IconPeople,
  IconSettings,
  IconShield,
} from "./components/Icons.tsx";

/**
 * The three-column shell: a narrow rail on the left (Mattermost), the chat list
 * beside it (Telegram), and the conversation filling the rest. The rail is what
 * keeps open channels and private chats from fighting over one list.
 */
export function App() {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    document.title = state.channels.some((c) => c.unread > 0)
      ? `(${state.channels.reduce((sum, c) => sum + (c.muted ? 0 : c.unread), 0)}) Kivora`
      : "Kivora";
  }, [state.channels]);

  // A wrong address is wrong whether or not anyone is signed in, so the 404
  // screen comes before the authentication gate rather than behind it. The
  // deliberate preview is the same screen, reached on purpose.
  if (state.route.kind === "notfound" || state.route.kind === "preview404") return <NotFound />;

  // The admin console is a different product in the same bundle: its own URL,
  // its own chrome, its own audience. Rendering it inside the messenger shell
  // would put a chat rail over a server dashboard.
  if (state.route.kind === "admin") return <AdminConsole tab={state.route.tab} />;

  if (state.phase === "loading") {
    return (
      <div className="splash">
        <img src="/brand/icon-192.png" alt="" width={72} height={72} />
        <p>{t("app.loading")}</p>
      </div>
    );
  }

  if (state.phase !== "ready") return <AuthScreen />;

  const view = state.view;
  const section: Section = view === "channels" ? "channels" : view === "archive" ? "archive" : "chats";
  const unread = state.channels.reduce((sum, c) => sum + (c.muted ? 0 : c.unread), 0);
  const archived = state.channels.filter((c) => c.archived).length;

  return (
    <div className="shell">
      <nav className="rail">
        {/* The mark is the way home: one click always lands on the full chat
            list, from anywhere in the app. */}
        <button className="rail__brand" title={t("nav.home")} onClick={() => session.goHome()}>
          <img src="/brand/icon-192.png" alt={t("app.name")} width={34} height={34} />
        </button>

        <RailButton active={view === "chats"} onClick={() => session.setView("chats")} label={t("nav.chats")}>
          <IconChats />
          {unread > 0 && <span className="rail__badge">{unread > 99 ? "99+" : unread}</span>}
        </RailButton>

        <RailButton
          active={view === "channels"}
          onClick={() => session.setView("channels")}
          label={t("nav.channels")}
        >
          <IconChannels />
        </RailButton>

        <RailButton active={false} onClick={() => setComposing(true)} label={t("nav.people")}>
          <IconPeople />
        </RailButton>

        {archived > 0 && (
          <RailButton
            active={view === "archive"}
            onClick={() => session.setView("archive")}
            label={t("nav.archive")}
          >
            <IconArchive />
          </RailButton>
        )}

        <div className="rail__spacer" />

        {state.user?.isAdmin && (
          <RailButton active={false} onClick={() => session.openAdmin()} label={t("nav.admin")}>
            <IconShield />
          </RailButton>
        )}

        <span
          className={`rail__net rail__net--${state.connection}`}
          title={
            state.connection === "online"
              ? t("call.connected")
              : state.connection === "connecting"
                ? t("call.connecting")
                : t("chat.offline")
          }
        />

        <RailButton
          active={view === "settings"}
          onClick={() => session.setView("settings")}
          label={t("nav.settings")}
        >
          <IconSettings />
        </RailButton>

        <button className="rail__me" onClick={() => session.setView("settings")} title={state.user?.displayName}>
          <Avatar
            name={state.user?.displayName ?? "?"}
            hue={state.user?.avatarHue ?? 200}
            avatar={state.user?.avatar}
            size={32}
          />
        </button>
      </nav>

      {view === "settings" ? (
        <SettingsPanel />
      ) : (
        <>
          <Sidebar section={section} onCompose={() => setComposing(true)} />
          <ChatView />
        </>
      )}

      {composing && <ComposeDialog onClose={() => setComposing(false)} />}

      <IncomingCall />
      {state.call && <CallOverlay />}

      {state.notice && (
        <div className="toast">
          <span>{state.notice}</span>
          <button onClick={() => session.dismissNotice()} aria-label={t("common.close")}>
            <IconClose width={15} height={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function RailButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button className={`rail__btn${active ? " rail__btn--on" : ""}`} onClick={onClick} title={label}>
      {children}
    </button>
  );
}
