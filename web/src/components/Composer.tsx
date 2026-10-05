import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import type { DecryptedMessage } from "../lib/session.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { formatBytes } from "../i18n/index.ts";
import { EmojiPicker } from "./EmojiPicker.tsx";
import { IconClose, IconFile, IconImage, IconPaperclip, IconPlay, IconSend, IconSmile } from "./Icons.tsx";

interface Props {
  channelId: string;
  maxBytes: number;
  replyTo: DecryptedMessage | null;
  onCancelReply: () => void;
}

export function Composer({ channelId, maxBytes, replyTo, onCancelReply }: Props) {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();

  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastTyping = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const bytes = new TextEncoder().encode(text).length;
  const tooLong = bytes > maxBytes;
  const maxFile = state.server?.maxFileBytes ?? 32 << 20;

  function grow() {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const accepted: File[] = [];
    for (const file of Array.from(list)) {
      if (file.size > maxFile) {
        setError(t("media.tooLarge", { limit: formatBytes(maxFile) }));
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) {
      setError(null);
      setFiles((current) => [...current, ...accepted].slice(0, 12));
    }
  }

  function submit() {
    if ((!text.trim() && files.length === 0) || tooLong) return;
    void session.sendMessage(channelId, text, { files, replyTo: replyTo?.id });
    setText("");
    setFiles([]);
    onCancelReply();
    requestAnimationFrame(grow);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter starts a line — the convention both Telegram
    // and Mattermost use, so nobody has to learn anything here.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  /** Pasting a screenshot should attach it, not paste a file name. */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  }

  function insertEmoji(emoji: string) {
    const el = area.current;
    if (!el) {
      setText((current) => current + emoji);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + emoji.length, start + emoji.length);
      grow();
    });
  }

  return (
    <div
      className="composerWrap"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {replyTo && (
        <div className="composer__reply">
          <span className="composer__replyText">
            <strong>{t("chat.replyTo")}</strong>
            {replyTo.text?.slice(0, 120) || t("media.file")}
          </span>
          <button className="iconbtn" onClick={onCancelReply} aria-label={t("common.close")}>
            <IconClose width={16} height={16} />
          </button>
        </div>
      )}

      {files.length > 0 && (
        <div className="composer__files">
          {files.map((file, i) => (
            <span key={`${file.name}-${i}`} className="chipFile">
              {file.type.startsWith("image/") ? (
                <IconImage width={14} height={14} />
              ) : file.type.startsWith("video/") ? (
                <IconPlay width={14} height={14} />
              ) : (
                <IconFile width={14} height={14} />
              )}
              <span className="chipFile__name">{file.name}</span>
              <em>{formatBytes(file.size)}</em>
              <button onClick={() => setFiles((c) => c.filter((_, index) => index !== i))}>✕</button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="composer__error">{error}</p>}

      <div className="composer">
        <div className="composer__tools">
          <button
            className="iconbtn"
            title={t("composer.emoji")}
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <IconSmile />
          </button>
          <button
            className="iconbtn"
            title={t("composer.attachPhoto")}
            onClick={() => mediaInput.current?.click()}
          >
            <IconImage />
          </button>
          <button
            className="iconbtn"
            title={t("composer.attachFile")}
            onClick={() => fileInput.current?.click()}
          >
            <IconPaperclip />
          </button>
        </div>

        <textarea
          ref={area}
          value={text}
          rows={1}
          placeholder={t("composer.placeholder")}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
            setText(e.target.value);
            grow();
            const now = Date.now();
            if (now - lastTyping.current > 2500) {
              lastTyping.current = now;
              session.notifyTyping(channelId);
            }
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <button
          className="composer__send"
          onClick={submit}
          disabled={(!text.trim() && files.length === 0) || tooLong}
          title={tooLong ? t("composer.tooLong") : t("composer.send")}
        >
          <IconSend />
        </button>

        {tooLong && (
          <span className="composer__limit">
            {bytes} / {maxBytes}
          </span>
        )}

        {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
      </div>

      <input
        ref={mediaInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
