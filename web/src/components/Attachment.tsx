import { useEffect, useState } from "react";

import type { AttachmentPayload } from "@kivora/crypto";
import { useSession } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { formatBytes, formatDuration } from "../i18n/index.ts";
import { IconDownload, IconExpand, IconFile, IconPlay } from "./Icons.tsx";

interface Props {
  channelId: string;
  attachment: AttachmentPayload;
  onOpen: () => void;
}

/**
 * One attachment inside a bubble.
 *
 * The bytes on the server are ciphertext, so nothing here can be an `img src`
 * pointing at a URL: the file is fetched, decrypted in this tab, and turned
 * into an object URL. The blurred thumbnail that shows meanwhile travels
 * *inside* the encrypted message, which is why there is something to look at
 * before the download finishes.
 */
export function Attachment({ channelId, attachment, onOpen }: Props) {
  const session = useSession();
  const { t } = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const visual = attachment.kind === "image" || attachment.kind === "video";

  useEffect(() => {
    if (!visual) return;
    let cancelled = false;
    session
      .attachmentUrl(channelId, attachment)
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session, channelId, attachment, visual]);

  if (!visual) {
    return (
      <button className="att att--file" onClick={() => void session.saveAttachment(channelId, attachment)}>
        <span className="att__icon">
          <IconFile />
        </span>
        <span className="att__meta">
          <strong>{attachment.name}</strong>
          <em>{formatBytes(attachment.size)}</em>
        </span>
        <IconDownload width={17} height={17} />
      </button>
    );
  }

  // Keep the bubble the right shape before the picture lands, so the layout
  // does not jump when it does.
  const ratio =
    attachment.width && attachment.height
      ? Math.min(Math.max(attachment.width / attachment.height, 0.55), 1.9)
      : 1.4;

  return (
    <figure className="att att--media" style={{ aspectRatio: String(ratio) }}>
      {attachment.thumb && !url && <img className="att__thumb" src={attachment.thumb} alt="" />}

      {url && attachment.kind === "image" && (
        <img className="att__full" src={url} alt={attachment.name} onClick={onOpen} />
      )}
      {url && attachment.kind === "video" && (
        <>
          <video
            className="att__full"
            src={url}
            poster={attachment.thumb}
            controls
            playsInline
            preload="metadata"
          />
          {/* The viewer was previously reachable only by opening an *image* in
              the same message and arrowing across, so a video-on-its-own could
              never be expanded. This button is that missing door; it sits clear
              of the native controls so it does not fight the play button. */}
          <button className="att__expand" onClick={onOpen} title={t("media.open")}>
            <IconExpand width={16} height={16} />
          </button>
        </>
      )}

      {!url && !failed && (
        <span className="att__state">
          {attachment.kind === "video" ? <IconPlay width={22} height={22} /> : null}
          {t("media.decrypting")}
        </span>
      )}
      {failed && <span className="att__state att__state--bad">{t("media.failed")}</span>}

      {attachment.duration ? (
        <span className="att__badge">{formatDuration(attachment.duration)}</span>
      ) : null}
    </figure>
  );
}
