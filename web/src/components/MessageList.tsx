import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AttachmentPayload } from "@kivora/crypto";
import type { ChannelJSON } from "../lib/api.ts";
import type { DecryptedMessage } from "../lib/session.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { formatDayBreak, formatTime } from "../i18n/index.ts";
import { Attachment } from "./Attachment.tsx";
import { Avatar } from "./Avatar.tsx";
import { MediaViewer } from "./MediaViewer.tsx";
import { IconChannels, IconLock, IconPin, IconTrash } from "./Icons.tsx";
import { hueOf } from "./Sidebar.tsx";

interface Props {
  channel: ChannelJSON;
  messages: DecryptedMessage[];
  onReply: (message: DecryptedMessage) => void;
  jumpTo?: string | null;
}

/**
 * Telegram-style bubbles: consecutive messages from one person are grouped,
 * which is what makes a busy channel readable, and the timestamp only appears
 * once per group.
 */
export function MessageList({ channel, messages, onReply, jumpTo }: Props) {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [viewer, setViewer] = useState<{ items: AttachmentPayload[]; index: number } | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channel.id]);

  useEffect(() => {
    if (!jumpTo) return;
    const node = document.getElementById(`msg-${jumpTo}`);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("msg--flash");
      setTimeout(() => node.classList.remove("msg--flash"), 1400);
    }
  }, [jumpTo]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60) void session.loadOlder(channel.id);
  }

  const ordered = [...messages].sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
  let lastDay = "";

  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      <div className="messages__intro">
        {channel.encrypted ? <IconLock width={14} height={14} /> : <IconChannels width={14} height={14} />}
        {channel.encrypted ? t("chat.introEncrypted") : t("chat.introOpen")}
      </div>

      {ordered.map((m, i) => {
        const mine = m.senderId === state.user?.id;
        const member = channel.members?.find((x) => x.userId === m.senderId);
        const prev = ordered[i - 1];
        const grouped =
          prev !== undefined &&
          prev.senderId === m.senderId &&
          m.createdAt - prev.createdAt < 5 * 60_000;

        const day = new Date(m.createdAt).toDateString();
        const dayBreak = day !== lastDay;
        lastDay = day;

        const replied = m.replyTo ? ordered.find((x) => x.id === m.replyTo) : undefined;

        return (
          <div key={m.id}>
            {dayBreak && (
              <div className="daybreak">
                <span>{formatDayBreak(m.createdAt)}</span>
              </div>
            )}
            <div
              id={`msg-${m.id}`}
              className={`msg${mine ? " msg--mine" : ""}${grouped ? " msg--grouped" : ""}`}
            >
              {!mine && !grouped && (
                <Avatar
                  name={member?.displayName ?? "?"}
                  hue={member?.avatarHue ?? hueOf(m.senderId)}
                  avatar={member?.avatar}
                  size={32}
                />
              )}
              <div className="msg__bubble">
                {!mine && !grouped && channel.kind !== "dm" && (
                  <span
                    className="msg__author"
                    style={{ color: `hsl(${member?.avatarHue ?? 200} 70% 70%)` }}
                  >
                    {member?.displayName ?? m.senderId}
                  </span>
                )}

                {replied && (
                  <span className="msg__quote">
                    <strong>
                      {channel.members?.find((x) => x.userId === replied.senderId)?.displayName ?? ""}
                    </strong>
                    {replied.text?.slice(0, 100) || t("media.file")}
                  </span>
                )}

                {m.attachments && m.attachments.length > 0 && (
                  <div className={`msg__atts msg__atts--${Math.min(m.attachments.length, 3)}`}>
                    {m.attachments.map((attachment) => (
                      <Attachment
                        key={attachment.id}
                        channelId={channel.id}
                        attachment={attachment}
                        onOpen={() => {
                          // The viewer only holds pictures and video, so the
                          // position has to be looked up *in that list*. Using
                          // the index within m.attachments opened the wrong
                          // item whenever a document came first.
                          const items = m.attachments!.filter(
                            (a) => a.kind === "image" || a.kind === "video",
                          );
                          const index = items.findIndex((a) => a.id === attachment.id);
                          if (index >= 0) setViewer({ items, index });
                        }}
                      />
                    ))}
                  </div>
                )}

                {(m.text || m.deleted || m.problem) && (
                  <span className="msg__text">
                    {m.deleted ? (
                      <em className="msg__gone">{t("chat.deletedMessage")}</em>
                    ) : m.problem ? (
                      <em className="msg__problem" title={m.problem}>
                        🔒 {t("chat.undecryptable")}
                      </em>
                    ) : (
                      m.text
                    )}
                  </span>
                )}

                {m.uploading !== undefined && (
                  <span className="msg__upload">
                    <span className="msg__uploadBar" style={{ width: `${Math.round(m.uploading * 100)}%` }} />
                    {t("media.uploading", { percent: Math.round(m.uploading * 100) })}
                  </span>
                )}

                <span className="msg__meta">
                  {m.pinned && <IconPin width={12} height={12} />}
                  {m.failed && <em className="msg__failed">{t("chat.notSent")}</em>}
                  <time>{formatTime(m.createdAt)}</time>
                  {m.pending && !m.failed && <span className="msg__clock">⏳</span>}
                </span>

                {!m.deleted && !m.pending && (
                  <div className="msg__actions">
                    <button title={t("chat.reply")} onClick={() => onReply(m)}>
                      ↩
                    </button>
                    <button
                      title={m.pinned ? t("chat.unpin") : t("chat.pin")}
                      onClick={() => void session.setPinned(channel.id, m.id, !m.pinned)}
                    >
                      <IconPin width={13} height={13} />
                    </button>
                    {m.text && (
                      <button
                        title={t("chat.copy")}
                        onClick={() => void navigator.clipboard?.writeText(m.text ?? "")}
                      >
                        ⧉
                      </button>
                    )}
                    {mine && (
                      <button
                        title={t("chat.deleteForAll")}
                        onClick={() => void session.deleteMessage(channel.id, m.id)}
                      >
                        <IconTrash width={13} height={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {viewer && (
        <MediaViewer
          channelId={channel.id}
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
