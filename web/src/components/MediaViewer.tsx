import { useEffect, useState } from "react";

import type { AttachmentPayload } from "@kivora/crypto";
import { useSession } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { IconChevronLeft, IconClose, IconDownload } from "./Icons.tsx";

interface Props {
  channelId: string;
  items: AttachmentPayload[];
  index: number;
  onClose: () => void;
}

/** Full-screen viewer with keyboard navigation, over already-decrypted files. */
export function MediaViewer({ channelId, items, index, onClose }: Props) {
  const session = useSession();
  const { t } = useT();
  const [at, setAt] = useState(index);
  const [url, setUrl] = useState<string | null>(null);

  const current = items[at];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setAt((i) => Math.min(i + 1, items.length - 1));
      if (e.key === "ArrowLeft") setAt((i) => Math.max(i - 1, 0));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [items.length, onClose]);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setUrl(null);
    void session.attachmentUrl(channelId, current).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [session, channelId, current]);

  if (!current) return null;

  return (
    <div className="viewer" onClick={onClose}>
      <header className="viewer__bar" onClick={(e) => e.stopPropagation()}>
        <span className="viewer__name">{current.name}</span>
        <div className="viewer__actions">
          <button
            className="iconbtn"
            title={t("media.download")}
            onClick={() => void session.saveAttachment(channelId, current)}
          >
            <IconDownload />
          </button>
          <button className="iconbtn" title={t("media.close")} onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </header>

      <div className="viewer__stage" onClick={(e) => e.stopPropagation()}>
        {items.length > 1 && (
          <button
            className="viewer__nav viewer__nav--prev"
            title={t("media.prev")}
            onClick={() => setAt((i) => Math.max(i - 1, 0))}
            disabled={at === 0}
          >
            <IconChevronLeft />
          </button>
        )}

        {url ? (
          current.kind === "video" ? (
            <video src={url} controls autoPlay />
          ) : (
            <img src={url} alt={current.name} />
          )
        ) : (
          <p className="viewer__loading">{t("media.decrypting")}</p>
        )}

        {items.length > 1 && (
          <button
            className="viewer__nav viewer__nav--next"
            title={t("media.next")}
            onClick={() => setAt((i) => Math.min(i + 1, items.length - 1))}
            disabled={at === items.length - 1}
          >
            <IconChevronLeft style={{ transform: "rotate(180deg)" }} />
          </button>
        )}
      </div>
    </div>
  );
}
