/**
 * Calls.
 *
 * WebRTC in a mesh: every participant opens a peer connection to every other
 * participant, so audio and video go directly between people (or through the
 * operator's TURN relay when a NAT insists). The Kivora server carries only the
 * signalling — offers, answers and ICE candidates — which is the same metadata
 * it already has: who is talking to whom, and when.
 *
 * Honest limitation, and the UI says so: the media itself is protected by
 * WebRTC's own DTLS-SRTP, which is encrypted in transit but terminates at each
 * peer. Against the server that is fine here, because the server is not a peer.
 * Against a TURN relay it is also fine — a relay forwards encrypted SRTP. What
 * is *not* yet done is the end-to-end key ratchet that would survive a
 * malicious SFU, and Kivora does not use an SFU, so a mesh keeps that honest.
 *
 * A mesh costs bandwidth: with N people each client sends N-1 streams. That is
 * why the group grid caps out around six before quality is worth managing, and
 * why an SFU is the obvious next step rather than a bigger mesh.
 */

import { callAuthString } from "@kivora/crypto";

import type { Api, CallRoom, IceConfig } from "./api.ts";

export interface RemoteStream {
  userId: string;
  deviceId: string;
  stream: MediaStream;
  video: boolean;
  screen: boolean;
}

export interface CallSnapshot {
  channelId: string;
  status: "connecting" | "ringing" | "active" | "ended";
  /** Why the call ended, when it ended without connecting. */
  ended: "declined" | "noAnswer" | "hangUp" | null;
  /**
   * The short authentication string: four groups of four digits derived from
   * the DTLS fingerprints actually in use. Both ends see the same one unless
   * something is sitting in the middle of the media. Empty until the first
   * peer connection has negotiated.
   */
  sas: string;
  startedAt: number;
  video: boolean;
  micOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
  local: MediaStream | null;
  remotes: RemoteStream[];
  participants: CallRoom["participants"];
  error: string | null;
}

interface Peer {
  connection: RTCPeerConnection;
  stream: MediaStream;
  userId: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

type SignalPayload =
  | { sdp: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit | null };

/**
 * How long to keep ringing before giving up.
 *
 * A call that rings forever is not a neutral default: the caller cannot tell a
 * slow answer from a phone in another room, and the callee comes back to a
 * banner for a call nobody is on any more.
 */
const RING_TIMEOUT_MS = 45_000;

export class CallManager {
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private peers = new Map<string, Peer>();
  private local: MediaStream | null = null;
  private camera: MediaStreamTrack | null = null;
  private screen: MediaStream | null = null;
  private ice: IceConfig | null = null;
  private listeners = new Set<(snapshot: CallSnapshot | null) => void>();

  private state: CallSnapshot | null = null;
  private selfDeviceId = "";

  constructor(
    private readonly api: Api,
    private readonly selfDevice: () => string,
  ) {}

  subscribe(fn: (snapshot: CallSnapshot | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): CallSnapshot | null {
    return this.state;
  }

  private emit(patch: Partial<CallSnapshot>): void {
    if (!this.state) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private clear(): void {
    this.clearRingTimeout();
    this.state = null;
    for (const fn of this.listeners) fn(null);
  }

  // ------------------------------------------------------------- lifecycle

  async start(channelId: string, opts: { video: boolean; ring: boolean }): Promise<void> {
    if (this.state) await this.hangUp();
    this.selfDeviceId = this.selfDevice();

    this.state = {
      channelId,
      status: opts.ring ? "ringing" : "connecting",
      startedAt: Date.now(),
      video: opts.video,
      micOn: true,
      cameraOn: opts.video,
      sharing: false,
      local: null,
      remotes: [],
      participants: [],
      error: null,
      ended: null,
      sas: "",
    };
    for (const fn of this.listeners) fn(this.state);

    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      this.emit({ status: "ended", error: "unsupported" });
      return;
    }

    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: opts.video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      this.camera = this.local.getVideoTracks()[0] ?? null;
    } catch {
      this.emit({ status: "ended", error: "denied" });
      return;
    }

    try {
      this.ice = await this.api.ice();
    } catch {
      this.ice = { iceServers: [], hasRelay: false };
    }

    this.emit({ local: this.local });
    this.api.push({ type: "call.join", channel: channelId, data: { video: opts.video } });
    if (opts.ring) {
      this.api.push({ type: "call.ring", channel: channelId, data: { video: opts.video } });
      this.armRingTimeout();
    }
  }

  async hangUp(): Promise<void> {
    const channelId = this.state?.channelId;
    if (channelId) this.api.push({ type: "call.leave", channel: channelId });
    this.teardown();
    this.clear();
  }

  /**
   * Stop ringing because the other side said no, or never said anything.
   *
   * Distinct from hangUp only in that the caller is told why, and the reason
   * survives one render so the overlay can show it before disappearing.
   */
  private giveUp(reason: "declined" | "noAnswer"): void {
    if (!this.state || this.state.status === "active") return;
    const channelId = this.state.channelId;
    this.api.push({ type: "call.leave", channel: channelId });
    this.teardown();
    this.emit({ status: "ended", ended: reason });
    // Leave the reason on screen briefly, then clear.
    setTimeout(() => {
      if (this.state?.status === "ended") this.clear();
    }, 2500);
  }

  /** The other side declined. Only meaningful while we are still ringing. */
  onDeclined(channelId: string): void {
    if (this.state?.channelId !== channelId) return;
    this.giveUp("declined");
  }

  private armRingTimeout(): void {
    this.clearRingTimeout();
    this.ringTimer = setTimeout(() => this.giveUp("noAnswer"), RING_TIMEOUT_MS);
  }

  private clearRingTimeout(): void {
    if (this.ringTimer !== null) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
  }

  /** Release every device and connection. Does not touch the snapshot. */
  private teardown(): void {
    this.clearRingTimeout();
    for (const peer of this.peers.values()) peer.connection.close();
    this.peers.clear();

    this.local?.getTracks().forEach((track) => track.stop());
    this.screen?.getTracks().forEach((track) => track.stop());
    this.local = null;
    this.screen = null;
    this.camera = null;
  }

  // ---------------------------------------------------------------- controls

  toggleMic(): void {
    if (!this.local || !this.state) return;
    const on = !this.state.micOn;
    this.local.getAudioTracks().forEach((track) => (track.enabled = on));
    this.emit({ micOn: on });
  }

  toggleCamera(): void {
    if (!this.local || !this.state) return;
    const on = !this.state.cameraOn;
    this.local.getVideoTracks().forEach((track) => (track.enabled = on));
    this.emit({ cameraOn: on });
    this.api.push({
      type: "call.flags",
      channel: this.state.channelId,
      data: { video: on, screen: this.state.sharing },
    });
  }

  /**
   * Screen sharing swaps the outgoing video track rather than renegotiating,
   * which is why the switch is instant and does not interrupt audio.
   */
  async toggleScreen(): Promise<void> {
    if (!this.state) return;
    if (this.state.sharing) {
      this.screen?.getTracks().forEach((track) => track.stop());
      this.screen = null;
      await this.replaceOutgoingVideo(this.camera);
      this.emit({ sharing: false });
    } else {
      try {
        this.screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch {
        return; // the user dismissed the picker
      }
      const track = this.screen.getVideoTracks()[0] ?? null;
      if (track) {
        // Stopping from the browser's own "stop sharing" bar must also flip
        // our state back, or the button lies.
        track.onended = () => void this.toggleScreen();
      }
      await this.replaceOutgoingVideo(track);
      this.emit({ sharing: true });
    }
    this.api.push({
      type: "call.flags",
      channel: this.state.channelId,
      data: { video: this.state.cameraOn, screen: this.state.sharing },
    });
  }

  private async replaceOutgoingVideo(track: MediaStreamTrack | null): Promise<void> {
    for (const peer of this.peers.values()) {
      const sender = peer.connection.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(track);
    }
  }

  // ------------------------------------------------------------- signalling

  /** Called when the server reports who is in the room. */
  onRoom(room: CallRoom): void {
    if (!this.state || room.channelId !== this.state.channelId) return;
    this.emit({ participants: room.participants });

    const live = new Set(room.participants.map((p) => p.deviceId));
    for (const [deviceId, peer] of this.peers) {
      if (!live.has(deviceId)) {
        peer.connection.close();
        this.peers.delete(deviceId);
      }
    }
    this.emit({ remotes: this.collectRemotes(room) });

    for (const participant of room.participants) {
      if (participant.deviceId === this.selfDeviceId) continue;
      if (!this.peers.has(participant.deviceId)) {
        void this.connectTo(participant.userId, participant.deviceId);
      }
    }
    if (room.participants.length > 1 && this.state.status !== "active") {
      this.clearRingTimeout();
      this.emit({ status: "active" });
    }

    // Everyone else hung up. Sitting alone in a connected call with the
    // microphone still live is not a state anyone wants to be left in — and
    // it is easy to miss, because the interface looks exactly like a call.
    if (room.participants.length <= 1 && this.state.status === "active") {
      this.api.push({ type: "call.leave", channel: this.state.channelId });
      this.teardown();
      this.emit({ status: "ended", ended: "hangUp" });
      setTimeout(() => {
        if (this.state?.status === "ended") this.clear();
      }, 1800);
    }
  }

  /**
   * Recompute the call's short authentication string from the DTLS
   * fingerprints on both sides of every peer connection.
   *
   * This is the answer to the one honest hole in the call design: DTLS-SRTP
   * encrypts the media between browsers, but the fingerprints that bind those
   * keys to people travel through the signalling server. A server that swaps
   * them terminates both legs and hears the call, with a padlock showing at
   * both ends. Hashing the fingerprints that were actually used gives the two
   * people something to compare that a substitution cannot keep consistent.
   */
  private refreshSas(): void {
    if (!this.state) return;
    const seen = new Set<string>();
    for (const peer of this.peers.values()) {
      for (const sdp of [peer.connection.localDescription?.sdp, peer.connection.remoteDescription?.sdp]) {
        for (const fp of fingerprintsIn(sdp)) seen.add(fp);
      }
    }
    const sas = callAuthString([...seen]);
    if (sas !== this.state.sas) this.emit({ sas });
  }

  async onSignal(from: string, fromDevice: string, payload: SignalPayload): Promise<void> {
    if (!this.state) return;
    const peer = this.peers.get(fromDevice) ?? (await this.connectTo(from, fromDevice));
    if (!peer) return;

    try {
      if ("sdp" in payload && payload.sdp) {
        // Perfect negotiation: the impolite peer ignores a colliding offer
        // rather than both sides tearing the connection down.
        const offerCollision =
          payload.sdp.type === "offer" &&
          (peer.makingOffer || peer.connection.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await peer.connection.setRemoteDescription(payload.sdp);
        if (payload.sdp.type === "offer") {
          await peer.connection.setLocalDescription();
          this.send(fromDevice, from, { sdp: peer.connection.localDescription!.toJSON() });
        }
        this.refreshSas();
      } else if ("candidate" in payload) {
        try {
          if (payload.candidate) await peer.connection.addIceCandidate(payload.candidate);
        } catch {
          if (!peer.ignoreOffer) throw new Error("ice");
        }
      }
    } catch {
      /* a failed negotiation with one peer must not end the whole call */
    }
  }

  private async connectTo(userId: string, deviceId: string): Promise<Peer | null> {
    if (!this.state || !this.local) return null;
    if (this.peers.has(deviceId)) return this.peers.get(deviceId)!;

    const connection = new RTCPeerConnection({ iceServers: this.ice?.iceServers ?? [] });
    const stream = new MediaStream();
    // Deterministic politeness: the device with the smaller id yields. Both
    // sides compute the same answer without another round trip.
    const peer: Peer = {
      connection,
      stream,
      userId,
      polite: this.selfDeviceId < deviceId,
      makingOffer: false,
      ignoreOffer: false,
    };
    this.peers.set(deviceId, peer);

    for (const track of this.local.getTracks()) connection.addTrack(track, this.local);

    connection.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) stream.addTrack(track);
      this.emit({ remotes: this.collectRemotes() });
    };
    connection.onicecandidate = (event) => {
      this.send(deviceId, userId, { candidate: event.candidate?.toJSON() ?? null });
    };
    connection.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await connection.setLocalDescription();
        this.send(deviceId, userId, { sdp: connection.localDescription!.toJSON() });
        this.refreshSas();
      } catch {
        /* ignored: the next negotiation attempt will retry */
      } finally {
        peer.makingOffer = false;
      }
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed") connection.restartIce();
      if (connection.connectionState === "connected") {
        this.clearRingTimeout();
        this.emit({ status: "active" });
      }
    };

    return peer;
  }

  private send(toDevice: string, to: string, payload: SignalPayload): void {
    if (!this.state) return;
    this.api.push({
      type: "call.signal",
      channel: this.state.channelId,
      data: { to, toDevice, payload },
    });
  }

  private collectRemotes(room?: CallRoom): RemoteStream[] {
    const flags = new Map(
      (room?.participants ?? this.state?.participants ?? []).map((p) => [p.deviceId, p]),
    );
    const out: RemoteStream[] = [];
    for (const [deviceId, peer] of this.peers) {
      const info = flags.get(deviceId);
      out.push({
        userId: peer.userId,
        deviceId,
        stream: peer.stream,
        video: info?.video ?? false,
        screen: info?.screen ?? false,
      });
    }
    return out;
  }
}

/**
 * Pull the DTLS fingerprints out of an SDP blob.
 *
 * `a=fingerprint:sha-256 AA:BB:...` appears once per media section, and
 * usually repeats the same value; the caller de-duplicates. Parsing SDP with a
 * regex is normally a bad idea, but this one line has a fixed grammar and the
 * alternative — a full SDP parser — would be a dependency carrying far more
 * attack surface than it removes.
 */
function fingerprintsIn(sdp: string | undefined): string[] {
  if (!sdp) return [];
  const out: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:\s*\S+\s+([0-9A-Fa-f:]+)/.exec(line.trim());
    if (m) out.push(m[1]!);
  }
  return out;
}
