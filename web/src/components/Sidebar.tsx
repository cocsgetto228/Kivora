import { useMemo, useState } from "react";

import type { ChannelJSON } from "../lib/api.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { formatListStamp } from "../i18n/index.ts";
import { Avatar } from "./Avatar.tsx";
import { ChatMenu } from "./ChatMenu.tsx";
import { IconDots, IconImage, IconLock, IconPhone, IconPin, IconPlus, IconSearch } from "./Icons.tsx";

export type Section = "chats" | "channels" | "archive";

interface Props {
  section: Section;
  onCompose: () => void;
}

/** The chat list: Telegram's density and preview line, with Mattermost's split
 *  between private conversations and open channels. */
export function Sidebar({ section, onCompose }: Props) {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const list = useMemo(() => {
    let source = state.channels;
    if (section === "archive") source = source.filter((c) => c.archived);
    else source = source.filter((c) => !c.archived);
    if (section === "channels") source = source.filter((c) => c.kind === "channel");

    const needle = query.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((c) => channelTitle(c, state.user?.id).toLowerCase().includes(needle));
  }, [section, state.channels, state.user?.id, query]);

  const browse = section === "channels" ? state.browse : [];
  const callChannels = new Set(state.activeRooms.map((r) => r.channelId));

  return (
    <aside className="sidebar">
      <header className="sidebar__head">
        <div className="search">
          <IconSearch width={16} height={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={section === "channels" ? t("sidebar.searchChannels") : t("sidebar.searchChats")}
          />
        </div>
        <button className="iconbtn" onClick={onCompose} title={t("sidebar.newChat")}>
          <IconPlus />
        </button>
      </header>

      <div className="sidebar__list">
        {list.length === 0 && (
          <p className="sidebar__empty">
            {section === "archive" ? t("sidebar.emptyArchive") : t("sidebar.empty")}
          </p>
        )}

        {list.map((channel) => {
          const title = channelTitle(channel, state.user?.id, t("chat.savedMessages"));
          const peer = channel.kind === "dm" ? otherMember(channel, state.user?.id) : undefined;
          const online = peer ? state.online.includes(peer.userId) : false;
          const typing = (state.typing[channel.id] ?? []).length > 0;
          const preview = channel.lastMessage;

          return (
            <div key={channel.id} className="rowWrap">
              <button
                className={`row${state.activeChannelId === channel.id ? " row--on" : ""}`}
                onClick={() => void session.openChannel(channel.id)}
              >
                <Avatar
                  name={title}
                  hue={peer?.avatarHue ?? hueOf(channel.id)}
                  avatar={peer?.avatar ?? channel.avatar}
                  online={peer ? online : undefined}
                  square={channel.kind !== "dm"}
                  verified={peer ? session.trustStateOf(peer.userId) === "verified" : false}
                />
                <span className="row__body">
                  <span className="row__top">
                    <span className="row__title">
                      {channel.kind === "channel" && <span className="row__hash">#</span>}
                      {title}
                      {channel.pinned && <IconPin width={11} height={11} className="row__pin" />}
                    </span>
                    {channel.lastMsgAt > 0 && <time>{formatListStamp(channel.lastMsgAt)}</time>}
                  </span>
                  <span className="row__bottom">
                    <span className="row__preview">
                      {typing ? (
                        <em>{t("sidebar.typing")}</em>
                      ) : callChannels.has(channel.id) ? (
                        <em className="row__call">
                          <IconPhone width={12} height={12} />
                          {t("call.connected")}
                        </em>
                      ) : preview?.kind === "media" ? (
                        <>
                          <IconImage width={12} height={12} />
                          {t("media.photo")}
                        </>
                      ) : channel.encrypted ? (
                        <>
                          <IconLock width={12} height={12} />
                          {t("sidebar.encrypted")}
                        </>
                      ) : (
                        channel.topic || t("sidebar.openChannel")
                      )}
                    </span>
                    {channel.unread > 0 && (
                      <span className={`badge${channel.muted ? " badge--muted" : ""}`}>
                        {channel.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>

              <button
                className="rowWrap__more"
                title={t("menu.actions")}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === channel.id ? null : channel.id);
                }}
              >
                <IconDots width={16} height={16} />
              </button>

              {menuFor === channel.id && (
                <ChatMenu channel={channel} align="left" onClose={() => setMenuFor(null)} />
              )}
            </div>
          );
        })}

        {browse.length > 0 && (
          <>
            <p className="sidebar__section">{t("sidebar.joinable")}</p>
            {browse.map((channel) => (
              <button
                key={channel.id}
                className="row row--muted"
                onClick={() => void session.joinChannel(channel.id)}
              >
                <Avatar name={channel.name} hue={hueOf(channel.id)} avatar={channel.avatar} square />
                <span className="row__body">
                  <span className="row__top">
                    <span className="row__title">
                      <span className="row__hash">#</span>
                      {channel.name}
                    </span>
                  </span>
                  <span className="row__bottom">
                    <span className="row__preview">{channel.topic || t("sidebar.joinHint")}</span>
                  </span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

export function channelTitle(channel: ChannelJSON, meId?: string, savedLabel = "Saved"): string {
  if (channel.kind !== "dm") return channel.name;
  const other = otherMember(channel, meId);
  if (!other || other.userId === meId) return savedLabel;
  return other.displayName;
}

export function otherMember(channel: ChannelJSON, meId?: string) {
  if (!channel.members) return undefined;
  return channel.members.find((m) => m.userId !== meId) ?? channel.members[0];
}

export function hueOf(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
