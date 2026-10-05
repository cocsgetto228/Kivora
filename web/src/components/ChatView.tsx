import { useEffect, useRef, useState } from "react";

import type { DecryptedMessage } from "../lib/session.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { Avatar } from "./Avatar.tsx";
import { ChatMenu } from "./ChatMenu.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { ThreadDialog } from "./ThreadDialog.tsx";
import { VerifyDialog } from "./VerifyDialog.tsx";
import {
  IconAlert,
  IconBranch,
  IconCamera,
  IconCheck,
  IconChevronLeft,
  IconClock,
  IconClose,
  IconDots,
  IconKey,
  IconLock,
  IconPhone,
  IconPin,
  IconShield,
  IconVideo,
} from "./Icons.tsx";
import { channelTitle, hueOf, otherMember } from "./Sidebar.tsx";

export function ChatView() {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();

  const [showInfo, setShowInfo] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  const [threadDialog, setThreadDialog] = useState(false);
  const [replyTo, setReplyTo] = useState<DecryptedMessage | null>(null);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState(0);
  const avatarInput = useRef<HTMLInputElement>(null);

  const channel = session.channelById(state.activeChannelId);

  useEffect(() => {
    setReplyTo(null);
    setPinnedIndex(0);
    setShowInfo(false);
  }, [state.activeChannelId]);

  if (!channel) {
    return (
      <section className="chat chat--empty">
        <div>
          <img src="/brand/mark-256.png" alt="" width={96} height={96} className="chat__emptyMark" />
          <h2>{t("chat.pickOne")}</h2>
          <p>{t("chat.pickOneHint")}</p>
        </div>
      </section>
    );
  }

  const title = channelTitle(channel, state.user?.id, t("chat.savedMessages"));
  const peer = channel.kind === "dm" ? otherMember(channel, state.user?.id) : undefined;
  const online = peer ? state.online.includes(peer.userId) : false;
  const typing = state.typing[channel.id] ?? [];
  const trust = peer ? session.trustStateOf(peer.userId) : "unknown";
  const pinned = state.pinned[channel.id] ?? [];
  const threads = state.threads[channel.id] ?? [];
  const parent = channel.parentId ? session.channelById(channel.parentId) : undefined;
  const room = state.activeRooms.find((r) => r.channelId === channel.id);
  const canCall = state.server?.calls !== false;
  const isOwner = channel.ownerId === state.user?.id;

  return (
    <section className="chat">
      <header className="chat__head">
        {parent && (
          <button className="iconbtn" title={t("thread.back")} onClick={() => void session.openChannel(parent.id)}>
            <IconChevronLeft />
          </button>
        )}

        <button
          className="chat__avatar"
          onClick={() => (isOwner && channel.kind !== "dm" ? avatarInput.current?.click() : setShowInfo(true))}
          title={isOwner && channel.kind !== "dm" ? t("settings.changeAvatar") : t("chat.about")}
        >
          <Avatar
            name={title}
            hue={peer?.avatarHue ?? hueOf(channel.id)}
            avatar={peer?.avatar ?? channel.avatar}
            size={38}
            square={channel.kind !== "dm"}
            verified={trust === "verified"}
          />
          {isOwner && channel.kind !== "dm" && (
            <span className="chat__avatarEdit">
              <IconCamera width={12} height={12} />
            </span>
          )}
        </button>

        <div className="chat__title">
          <h2>
            {channel.kind === "channel" && <span className="row__hash">#</span>}
            {channel.kind === "thread" && <IconBranch width={15} height={15} />}
            {title}
          </h2>
          <p>
            {typing.length > 0
              ? t("sidebar.typing")
              : parent
                ? t("thread.inGroup", { name: parent.name })
                : channel.kind === "dm"
                  ? online
                    ? t("chat.online")
                    : t("chat.offline")
                  : `${t("chat.members", { count: channel.members?.length ?? 0 })}${
                      channel.topic ? ` · ${channel.topic}` : ""
                    }`}
          </p>
        </div>

        {/* A timer changes what it means to send something, so the person on
            the other side has to see it before they answer — not only the
            person who set it. */}
        {channel.ttlSeconds > 0 && (
          <span className="chat__ttl" title={t("menu.ttl")}>
            <IconClock width={13} height={13} />
            {t("chat.ttlOn", { human: humanTTL(channel.ttlSeconds, t) })}
          </span>
        )}

        <div className="chat__actions">
          {channel.encrypted && (
            <button
              className={`pill pill--${trust}`}
              title={t("chat.e2eTitle")}
              onClick={() => peer && setVerifyFor(peer.userId)}
              disabled={!peer}
            >
              {trust === "changed" ? (
                <IconAlert width={13} height={13} />
              ) : trust === "verified" ? (
                <IconCheck width={13} height={13} />
              ) : (
                <IconLock width={13} height={13} />
              )}
              {t("chat.e2e")}
            </button>
          )}

          {canCall && (
            <>
              <button
                className="iconbtn"
                title={t("call.audio")}
                onClick={() => void session.startCall(channel.id, false)}
              >
                <IconPhone />
              </button>
              <button
                className="iconbtn"
                title={t("call.video")}
                onClick={() => void session.startCall(channel.id, true)}
              >
                <IconVideo />
              </button>
            </>
          )}

          <button className="btn btn--ghost" onClick={() => setShowInfo((v) => !v)}>
            {showInfo ? t("chat.hide") : t("chat.about")}
          </button>

          <div className="chat__menuAnchor">
            <button className="iconbtn" title={t("menu.actions")} onClick={() => setMenuOpen((v) => !v)}>
              <IconDots />
            </button>
            {menuOpen && <ChatMenu channel={channel} onClose={() => setMenuOpen(false)} />}
          </div>
        </div>
      </header>

      {room && room.participants.length > 0 && !state.call && (
        <button className="callBanner" onClick={() => void session.joinCall(channel.id, false)}>
          <IconPhone width={15} height={15} />
          {t("call.groupOngoing", { count: room.participants.length })}
          <span className="callBanner__join">{t("call.join")}</span>
        </button>
      )}

      {trust === "changed" && peer && (
        <button className="warnBanner" onClick={() => setVerifyFor(peer.userId)}>
          <IconAlert width={15} height={15} />
          {t("verify.changed")} — {t("verify.acknowledge")}
        </button>
      )}

      {pinned.length > 0 && (
        <div className="pinBar">
          <IconPin width={14} height={14} />
          <button
            className="pinBar__text"
            onClick={() => {
              const target = pinned[pinnedIndex % pinned.length];
              if (target) setJumpTo(target.id);
              setPinnedIndex((i) => (i + 1) % pinned.length);
            }}
          >
            <strong>{t("chat.pinnedCount", { count: pinned.length })}</strong>
            <span>{pinned[pinnedIndex % pinned.length]?.text?.slice(0, 90) || t("media.file")}</span>
          </button>
          <button
            className="iconbtn"
            title={t("chat.unpin")}
            onClick={() => {
              const target = pinned[pinnedIndex % pinned.length];
              if (target) void session.setPinned(channel.id, target.id, false);
            }}
          >
            <IconClose width={15} height={15} />
          </button>
        </div>
      )}

      <div className="chat__body">
        <MessageList
          channel={channel}
          messages={state.messages[channel.id] ?? []}
          onReply={setReplyTo}
          jumpTo={jumpTo}
        />

        {showInfo && (
          <aside className="info">
            <h3>
              <IconShield width={14} height={14} /> {t("crypto.title")}
            </h3>
            <p className="info__line">
              {t("compose.cipher")}: <span className="mono">{channel.suite || "—"}</span>
            </p>
            {peer && (
              <>
                <p className={`verifyState verifyState--${trust}`}>
                  {trust === "verified" ? (
                    <>
                      <IconCheck width={14} height={14} /> {t("verify.verified")}
                    </>
                  ) : trust === "changed" ? (
                    <>
                      <IconAlert width={14} height={14} /> {t("verify.changed")}
                    </>
                  ) : (
                    <>
                      <IconKey width={14} height={14} /> {t("verify.unverified")}
                    </>
                  )}
                </p>
                <button className="btn btn--ghost" onClick={() => setVerifyFor(peer.userId)}>
                  {t("verify.title")}
                </button>
              </>
            )}

            {(channel.kind === "group" || channel.kind === "channel") && (
              <>
                <h3>
                  <IconBranch width={14} height={14} /> {t("thread.title")}
                </h3>
                {threads.length === 0 && <p className="info__line">{t("thread.empty")}</p>}
                <ul className="threadList">
                  {threads.map((thread) => (
                    <li key={thread.id}>
                      <button onClick={() => void session.openChannel(thread.id)}>
                        <IconBranch width={14} height={14} />
                        <span>{thread.name}</span>
                        {thread.unread > 0 && <span className="badge">{thread.unread}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                <button className="btn btn--ghost" onClick={() => setThreadDialog(true)}>
                  {t("thread.new")}
                </button>
              </>
            )}

            <h3>{t("chat.members", { count: channel.members?.length ?? 0 })}</h3>
            <ul className="info__members">
              {(channel.members ?? []).map((m) => (
                <li key={m.userId}>
                  <Avatar
                    name={m.displayName}
                    hue={m.avatarHue}
                    avatar={m.avatar}
                    size={28}
                    verified={session.trustStateOf(m.userId) === "verified"}
                  />
                  <span>
                    {m.displayName}
                    <em>@{m.username}</em>
                  </span>
                  {state.online.includes(m.userId) && (
                    <i className="presence presence--on presence--inline" />
                  )}
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      <Composer
        channelId={channel.id}
        maxBytes={state.server?.maxMessageBytes ?? 65536}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />

      <input
        ref={avatarInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void session.setChannelAvatar(channel.id, file);
          e.target.value = "";
        }}
      />

      {verifyFor && (
        <VerifyDialog
          userId={verifyFor}
          name={channel.members?.find((m) => m.userId === verifyFor)?.displayName ?? ""}
          onClose={() => setVerifyFor(null)}
        />
      )}
      {threadDialog && <ThreadDialog parent={channel} onClose={() => setThreadDialog(false)} />}
    </section>
  );
}

/**
 * Turn a timer into the same words the menu uses, so the header and the menu
 * never describe the same setting differently.
 */
function humanTTL(seconds: number, t: (k: never) => string): string {
  if (seconds >= 2592000) return t("menu.ttlMonth" as never).toLowerCase();
  if (seconds >= 604800) return t("menu.ttlWeek" as never).toLowerCase();
  if (seconds >= 86400) return t("menu.ttlDay" as never).toLowerCase();
  return t("menu.ttlHour" as never).toLowerCase();
}
