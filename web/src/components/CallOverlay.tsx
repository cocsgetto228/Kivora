import { useEffect, useRef, useState } from "react";

import type { RemoteStream } from "../lib/calls.ts";
import { useSession, useSessionState } from "../state/useSession.ts";
import { useT } from "../i18n/useT.ts";
import { formatDuration } from "../i18n/index.ts";
import { Avatar } from "./Avatar.tsx";
import {
  IconAlert,
  IconMic,
  IconMicOff,
  IconPhoneOff,
  IconScreen,
  IconVideo,
  IconVideoOff,
} from "./Icons.tsx";
import { hueOf } from "./Sidebar.tsx";

/** Binds a MediaStream to a <video>; React cannot express srcObject in JSX. */
function Video({ stream, muted, mirrored }: { stream: MediaStream; muted?: boolean; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={mirrored ? "callTile__video callTile__video--mirror" : "callTile__video"}
    />
  );
}

export function CallOverlay() {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();
  const [elapsed, setElapsed] = useState(0);

  const call = state.call;

  useEffect(() => {
    if (!call || call.status !== "active") return;
    const started = call.startedAt;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [call?.status, call?.startedAt, call]);

  if (!call) return null;

  const channel = session.channelById(call.channelId);
  const members = channel?.members ?? [];
  const nameOf = (userId: string) =>
    members.find((m) => m.userId === userId)?.displayName ?? userId.slice(0, 6);

  const remotes: RemoteStream[] = call.remotes;
  const tiles = remotes.length + 1;
  const columns = tiles <= 1 ? 1 : tiles <= 4 ? 2 : 3;

  // Order matters: a call that ended because nobody picked up should say so,
  // not fall through to "Calling…" for the two seconds before it disappears.
  const statusText =
    call.error === "denied"
      ? t("call.mediaDenied")
      : call.error === "unsupported"
        ? t("call.unsupported")
        : call.ended === "declined"
          ? t("call.declined")
          : call.ended === "noAnswer"
            ? t("call.noAnswer")
            : call.status === "ended"
              ? t("call.ended")
              : call.status === "ringing"
                ? t("call.calling")
                : call.status === "connecting"
                  ? t("call.connecting")
                  : remotes.length === 0
                    ? t("call.calling")
                    : formatDuration(elapsed);

  return (
    <div className="call">
      <header className="call__head">
        <div>
          <h2>{channel ? channel.name || nameOf(remotes[0]?.userId ?? "") || t("call.audio") : t("call.audio")}</h2>
          <p>{statusText}</p>
        </div>
        {/* The short authentication string. DTLS-SRTP already encrypts the
            media between the two browsers; what it cannot do on its own is
            prove whose keys those are, because the fingerprints travel through
            the signalling server. Reading these sixteen digits to each other
            closes that: a server in the middle cannot make both ends agree. */}
        {call.sas ? (
          <div className="call__sas">
            <em>{t("call.sasLabel")}</em>
            <strong>{call.sas}</strong>
            <span>{t("call.sasHint")}</span>
          </div>
        ) : (
          <p className="call__notice">
            <IconAlert width={14} height={14} />
            {t("call.sasWaiting")}
          </p>
        )}
      </header>

      <div className="call__grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {remotes.map((remote) => (
          <div className="callTile" key={remote.deviceId}>
            {remote.video || remote.screen ? (
              <Video stream={remote.stream} />
            ) : (
              <div className="callTile__idle">
                <Avatar
                  name={nameOf(remote.userId)}
                  hue={members.find((m) => m.userId === remote.userId)?.avatarHue ?? hueOf(remote.userId)}
                  avatar={members.find((m) => m.userId === remote.userId)?.avatar}
                  size={84}
                />
                {/* Audio still has to play even with no picture. */}
                <Video stream={remote.stream} />
              </div>
            )}
            <span className="callTile__name">{nameOf(remote.userId)}</span>
          </div>
        ))}

        <div className="callTile callTile--self">
          {call.local && call.cameraOn ? (
            <Video stream={call.local} muted mirrored={!call.sharing} />
          ) : (
            <div className="callTile__idle">
              <Avatar
                name={state.user?.displayName ?? ""}
                hue={state.user?.avatarHue ?? 200}
                avatar={state.user?.avatar}
                size={84}
              />
            </div>
          )}
          <span className="callTile__name">{t("call.you")}</span>
        </div>
      </div>

      <footer className="call__bar">
        <button
          className={call.micOn ? "callBtn" : "callBtn callBtn--off"}
          title={call.micOn ? t("call.muteMic") : t("call.unmuteMic")}
          onClick={() => session.calls.toggleMic()}
        >
          {call.micOn ? <IconMic /> : <IconMicOff />}
        </button>
        <button
          className={call.cameraOn ? "callBtn" : "callBtn callBtn--off"}
          title={call.cameraOn ? t("call.stopVideo") : t("call.startVideo")}
          onClick={() => session.calls.toggleCamera()}
        >
          {call.cameraOn ? <IconVideo /> : <IconVideoOff />}
        </button>
        <button
          className={call.sharing ? "callBtn callBtn--on" : "callBtn"}
          title={call.sharing ? t("call.stopShare") : t("call.shareScreen")}
          onClick={() => void session.calls.toggleScreen()}
        >
          <IconScreen />
        </button>
        <button className="callBtn callBtn--end" title={t("call.hangUp")} onClick={() => void session.hangUp()}>
          <IconPhoneOff />
        </button>
      </footer>
    </div>
  );
}

/** The incoming-call banner, shown while someone is ringing this device. */
export function IncomingCall() {
  const session = useSession();
  const state = useSessionState();
  const { t } = useT();

  const call = state.incoming;
  if (!call || state.call) return null;

  const channel = session.channelById(call.channelId);

  return (
    <div className="ringing" role="alert" aria-label={t("call.incoming")}>
      <Avatar name={call.fromName || "?"} hue={hueOf(call.fromId)} size={48} />
      <div className="ringing__text">
        <strong>{t("call.incomingFrom", { name: call.fromName || channel?.name || "" })}</strong>
        <span>{call.video ? t("call.video") : t("call.audio")}</span>
      </div>
      <div className="ringing__actions">
        <button className="btn btn--danger" onClick={() => session.declineCall()}>
          {t("call.decline")}
        </button>
        {/* Answering a video call without turning the camera on is a normal
            thing to want, and toggling it off after connecting is too late —
            by then a frame has already been sent. */}
        {call.video && (
          <button
            className="btn"
            onClick={() => void session.joinCall(call.channelId, false)}
          >
            {t("call.audio")}
          </button>
        )}
        <button
          className="btn btn--ok"
          onClick={() => void session.joinCall(call.channelId, call.video)}
        >
          {t("call.accept")}
        </button>
      </div>
    </div>
  );
}
