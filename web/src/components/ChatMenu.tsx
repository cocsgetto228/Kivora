import { useEffect, useRef, useState } from "react";

import type { ChannelJSON } from "../lib/api.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import {
  IconArchive,
  IconBell,
  IconBellOff,
  IconCheck,
  IconClock,
  IconDownload,
  IconImage,
  IconLogOut,
  IconPin,
  IconTrash,
} from "./Icons.tsx";

/** Off, an hour, a day, a week, a month. */
const TTL_CHOICES = [
  { seconds: 0, key: "menu.ttlOff" },
  { seconds: 3600, key: "menu.ttlHour" },
  { seconds: 86400, key: "menu.ttlDay" },
  { seconds: 604800, key: "menu.ttlWeek" },
  { seconds: 2592000, key: "menu.ttlMonth" },
] as const;

interface Props {
  channel: ChannelJSON;
  onClose: () => void;
  /** Anchored under the row in the sidebar, or under the header button. */
  align?: "left" | "right";
}

/**
 * The three-dot menu. Everything here is a per-person action except clearing
 * history, which only removes the caller's own messages — a chat belongs to
 * everyone in it, so one person cannot erase another's words.
 */
export function ChatMenu({ channel, onClose, align = "right" }: Props) {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isOwner = channel.ownerId === state.user?.id;

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    try {
      await action();
    } finally {
      setBusy(null);
      onClose();
    }
  }

  return (
    <div className={`menu menu--${align}`} ref={box} role="menu">
      <button
        role="menuitem"
        onClick={() => void run("pin", () => session.setChatFlags(channel.id, { pinned: !channel.pinned }))}
      >
        <IconPin width={16} height={16} />
        {channel.pinned ? t("menu.unpinChat") : t("menu.pinChat")}
      </button>

      <button
        role="menuitem"
        onClick={() => void run("mute", () => session.setChatFlags(channel.id, { muted: !channel.muted }))}
      >
        {channel.muted ? <IconBell width={16} height={16} /> : <IconBellOff width={16} height={16} />}
        {channel.muted ? t("menu.unmute") : t("menu.mute")}
      </button>

      <button
        role="menuitem"
        onClick={() =>
          void run("archive", () => session.setChatFlags(channel.id, { archived: !channel.archived }))
        }
      >
        <IconArchive width={16} height={16} />
        {channel.archived ? t("menu.unarchive") : t("menu.archive")}
      </button>

      {channel.unread > 0 && (
        <button role="menuitem" onClick={() => void run("read", () => session.markRead(channel.id))}>
          <IconCheck width={16} height={16} />
          {t("menu.markRead")}
        </button>
      )}

      {/* Setting a group icon is a click on the header avatar; taking one off
          had no affordance at all, so an accidental upload was permanent. */}
      {isOwner && channel.kind !== "dm" && channel.avatar && (
        <button
          role="menuitem"
          onClick={() => void run("avatar", () => session.setChannelAvatar(channel.id, null))}
        >
          <IconImage width={16} height={16} />
          {t("menu.removeAvatar")}
        </button>
      )}

      <hr />

      {/* Disappearing messages. The list is short on purpose: a free-form
          duration invites people to set 47 minutes and then wonder why nobody
          else understood what that meant. */}
      <div className="menu__group" role="group" aria-label={t("menu.ttl")}>
        <span className="menu__label">
          <IconClock width={15} height={15} />
          {t("menu.ttl")}
        </span>
        <div className="menu__chips">
          {TTL_CHOICES.map(({ seconds, key }) => (
            <button
              key={key}
              className={channel.ttlSeconds === seconds ? "on" : ""}
              onClick={() => void run("ttl", () => session.setChannelTTL(channel.id, seconds))}
            >
              {t(key as never)}
            </button>
          ))}
        </div>
      </div>

      <hr />

      <button
        role="menuitem"
        onClick={() =>
          void run("export", async () => {
            const name = await session.exportChannel(channel.id);
            window.setTimeout(() => alert(t("menu.exported", { name })), 50);
          })
        }
      >
        <IconDownload width={16} height={16} />
        {busy === "export" ? t("menu.exporting") : t("menu.exportArchive")}
      </button>

      <button
        role="menuitem"
        className="menu__danger"
        onClick={() => void run("clear", () => session.clearHistory(channel.id))}
      >
        <IconTrash width={16} height={16} />
        {t("menu.clearHistory")}
      </button>

      {channel.kind !== "dm" && (
        <button
          role="menuitem"
          className="menu__danger"
          onClick={() => void run("leave", () => session.leaveChannel(channel.id))}
        >
          <IconLogOut width={16} height={16} />
          {t("menu.leave")}
        </button>
      )}
    </div>
  );
}
