/**
 * The transport layer: a typed wrapper over the REST API and the WebSocket.
 *
 * It knows nothing about encryption. Everything it sends and receives is
 * already opaque by the time it gets here, which is what makes it possible to
 * read this file and confirm that no plaintext ever reaches the network.
 */

export interface ServerInfo {
  name: string;
  version: string;
  protocol: number;
  registrationMode: "open" | "invite" | "closed";
  requireE2E: boolean;
  allowedSuites: string[];
  suites: { id: string; label: string; recommended?: boolean; notes?: string }[];
  maxMessageBytes: number;
  maxUploadBytes: number;
  maxFileBytes: number;
  maxAvatarBytes: number;
  calls: boolean;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarHue: number;
  avatar: string;
  bio: string;
  isAdmin: boolean;
  suspended: boolean;
  createdAt: number;
  lastSeenAt: number;
}

export interface Member {
  userId: string;
  username: string;
  displayName: string;
  avatarHue: number;
  avatar: string;
  role: string;
  lastSeenAt: number;
}

export interface DeviceJSON {
  id: string;
  userId: string;
  name: string;
  platform: string;
  suite: string;
  identityPub: string;
  signedPreKeyPub: string;
  signedPreKeySig: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
}

export interface KeyBundleJSON {
  device: DeviceJSON;
  preKeyId?: string;
  preKey?: string;
}

export interface MessageJSON {
  id: string;
  channelId: string;
  seq: number;
  senderId: string;
  senderDevice: string;
  suite: string;
  kind: string;
  header?: string;
  body: string;
  replyTo?: string;
  createdAt: number;
  editedAt: number;
  deleted: boolean;
  pinned: boolean;
  attachments?: string[];
  wrappedKey?: string;
}

export interface UploadJSON {
  id: string;
  ownerId: string;
  channelId: string;
  kind: "media" | "avatar";
  mime: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  createdAt: number;
}

export interface CallRoom {
  channelId: string;
  startedAt: number;
  participants: {
    userId: string;
    deviceId: string;
    video: boolean;
    screen: boolean;
    joinedAt: number;
  }[];
}

export interface IceConfig {
  iceServers: RTCIceServer[];
  hasRelay: boolean;
}

export interface AdminOverview {
  users: number;
  online: number;
  channels: number;
  messages: number;
  devices: number;
  fileBytes: number;
  logBytes: number;
  uptimeSec: number;
  messagesPerDay: number[];
  signupsPerDay: number[];
  days: string[];
  recent: User[];
  policy: {
    registration: string;
    allowedSuites: string[];
    requireE2E: boolean;
    rateRps: number;
    rateBurst: number;
    maxDevices: number;
    maxFileMb: number;
    sessionDays: number;
    sync: string;
  };
  runtime: { go: string; os: string; arch: string; goroutines: number; heapMb: number };
}

export interface AdminUserRow extends User {
  devices: number;
  online: boolean;
}

export interface AdminChannelRow {
  id: string;
  kind: string;
  name: string;
  slug: string;
  encrypted: boolean;
  suite: string;
  createdAt: number;
  lastMsgAt: number;
  messageCount: number;
  memberCount: number;
}

export interface ChannelJSON {
  id: string;
  kind: "dm" | "group" | "channel" | "thread";
  parentId?: string;
  slug: string;
  name: string;
  topic: string;
  avatar: string;
  ownerId: string;
  encrypted: boolean;
  suite: string;
  createdAt: number;
  lastSeq: number;
  lastMsgAt: number;
  members?: Member[];
  unread: number;
  lastReadSeq: number;
  lastMessage?: MessageJSON;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
  threadCount: number;
  pinnedCount: number;
  /** Disappearing messages: seconds, or 0 when history is kept. */
  ttlSeconds: number;
}

export interface WsEvent {
  type: string;
  channel?: string;
  data?: unknown;
  ts: number;
}

import { t, type Key } from "../i18n/index.ts";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

/**
 * Server error codes are stable identifiers, not prose: the wording lives in
 * the dictionaries so the same failure reads correctly in every language.
 */
const TRANSLATED = new Set<string>([
  "invalid_credentials",
  "username_taken",
  "username_length",
  "username_charset",
  "password_too_short",
  "registration_closed",
  "bad_invite",
  "rate_limited",
  "suite_rejected",
  "too_many_devices",
  "message_too_large",
  "not_a_member",
  "upload_too_large",
  "unsupported_media",
  "suspended",
  "forbidden",
  "not_found",
  "invalid_token",
  "missing_token",
  "device_revoked",
  "no_device",
  "invite_only",
  "not_owner",
  "last_admin",
  "bad_name",
  "bad_display_name",
  "bio_too_long",
  "bad_avatar",
  "empty_upload",
  "too_many_attachments",
  "cannot_add_to_dm",
  "suite_mismatch",
  "threads_need_a_group",
]);

// Codes deliberately left out, so they fall back to "server error (400)":
// internal, bad_request, bad_body, bad_kind, bad_key_material, missing_keys,
// too_many_keys, bad_attachment, missing_channel, conflict, not_your_device.
// Those mean the client sent something malformed - a bug here, not a thing the
// person did - and inventing friendly prose for them would hide it.

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (TRANSLATED.has(err.code)) return t(`error.${err.code}` as Key);
    return t("error.server", { status: err.status });
  }
  if (err instanceof Error) return err.message;
  return t("error.unknown");
}

export class Api {
  private token: string | null = null;
  private socket: WebSocket | null = null;
  private reconnectDelay = 1000;
  private closed = false;
  private listeners = new Set<(ev: WsEvent) => void>();
  private statusListeners = new Set<(online: boolean) => void>();

  constructor(public baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const payload = (await res.json()) as { error?: string };
        if (payload.error) code = payload.error;
      } catch {
        /* a non-JSON error body is still an error */
      }
      throw new ApiError(res.status, code);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ------------------------------------------------------------ public

  serverInfo(): Promise<ServerInfo> {
    return this.request("GET", "/api/v1/server");
  }

  register(input: {
    username: string;
    displayName: string;
    password: string;
    inviteCode?: string;
  }): Promise<{ token: string; user: User }> {
    return this.request("POST", "/api/v1/auth/register", input);
  }

  login(username: string, password: string): Promise<{ token: string; user: User }> {
    return this.request("POST", "/api/v1/auth/login", { username, password });
  }

  logout(): Promise<void> {
    return this.request("POST", "/api/v1/auth/logout");
  }

  me(): Promise<{ user: User; deviceId: string }> {
    return this.request("GET", "/api/v1/me");
  }

  updateProfile(displayName: string, bio: string, avatar?: string | null): Promise<{ user: User }> {
    return this.request("PATCH", "/api/v1/me", {
      displayName,
      bio,
      ...(avatar === undefined ? {} : { avatar: avatar ?? "" }),
    });
  }

  searchUsers(q: string): Promise<{ users: Member[] }> {
    return this.request("GET", `/api/v1/users?q=${encodeURIComponent(q)}`);
  }

  // ------------------------------------------------------------ devices

  registerDevice(input: {
    name: string;
    platform: string;
    suite: string;
    identityPub: string;
    signedPreKeyPub: string;
    signedPreKeySig: string;
    preKeys: { id: string; pub: string }[];
  }): Promise<{ device: DeviceJSON }> {
    return this.request("POST", "/api/v1/devices", input);
  }

  listDevices(): Promise<{ devices: DeviceJSON[]; current: string }> {
    return this.request("GET", "/api/v1/devices");
  }

  attachDevice(id: string): Promise<{ device: DeviceJSON; preKeysAvailable: number }> {
    return this.request("POST", `/api/v1/devices/${id}/attach`);
  }

  revokeDevice(id: string): Promise<void> {
    return this.request("DELETE", `/api/v1/devices/${id}`);
  }

  uploadPreKeys(preKeys: { id: string; pub: string }[]): Promise<{ stored: number; available: number }> {
    return this.request("POST", "/api/v1/devices/prekeys", { preKeys });
  }

  keyBundles(userId: string): Promise<{ bundles: KeyBundleJSON[] }> {
    return this.request("GET", `/api/v1/keys/${userId}`);
  }

  backfillKeys(deviceId: string, keys: Record<string, string>): Promise<{ stored: number }> {
    return this.request("POST", "/api/v1/keys/backfill", { deviceId, keys });
  }

  // ------------------------------------------------------------ channels

  listChannels(): Promise<{ channels: ChannelJSON[]; online: string[] }> {
    return this.request("GET", "/api/v1/channels");
  }

  browseChannels(): Promise<{ channels: ChannelJSON[] }> {
    return this.request("GET", "/api/v1/channels/browse");
  }

  createChannel(input: {
    kind: "group" | "channel";
    name: string;
    topic: string;
    members: string[];
    encrypted: boolean;
    suite: string;
  }): Promise<{ channel: ChannelJSON }> {
    return this.request("POST", "/api/v1/channels", input);
  }

  openDirect(userId: string, suite: string): Promise<{ channel: ChannelJSON }> {
    return this.request("POST", "/api/v1/channels/direct", { userId, suite });
  }

  channel(id: string): Promise<{ channel: ChannelJSON; isMember: boolean }> {
    return this.request("GET", `/api/v1/channels/${id}`);
  }

  joinChannel(id: string): Promise<void> {
    return this.request("POST", `/api/v1/channels/${id}/join`);
  }

  leaveChannel(id: string): Promise<void> {
    return this.request("POST", `/api/v1/channels/${id}/leave`);
  }

  addMember(id: string, userId: string): Promise<void> {
    return this.request("POST", `/api/v1/channels/${id}/members`, { userId });
  }

  channelDevices(id: string): Promise<{ devices: DeviceJSON[] }> {
    return this.request("GET", `/api/v1/channels/${id}/devices`);
  }

  history(id: string, before?: number, limit = 50): Promise<{ messages: MessageJSON[] }> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set("before", String(before));
    return this.request("GET", `/api/v1/channels/${id}/messages?${q}`);
  }

  send(
    id: string,
    input: {
      kind: string;
      suite: string;
      header: string;
      body: string;
      keys: Record<string, string>;
      replyTo?: string;
      clientId?: string;
      // Upload ids created earlier in this channel. The file *keys* are not
      // here - each one travels inside `body` - so this list is a pointer,
      // never a grant.
      attachments?: string[];
    },
  ): Promise<{ message: MessageJSON; clientId: string }> {
    return this.request("POST", `/api/v1/channels/${id}/messages`, input);
  }

  markRead(id: string, seq: number): Promise<void> {
    return this.request("POST", `/api/v1/channels/${id}/read`, { seq });
  }

  // ------------------------------------------------------------ files

  /**
   * Uploads raw bytes. Not JSON, not multipart: a base64 body would be a third
   * larger on the wire and a second copy in memory on both ends.
   */
  async upload(
    channelId: string,
    mime: string,
    data: Uint8Array,
    dims?: { width?: number; height?: number; duration?: number },
    onProgress?: (fraction: number) => void,
  ): Promise<UploadJSON> {
    const q = new URLSearchParams({ channel: channelId, mime });
    if (dims?.width) q.set("w", String(Math.round(dims.width)));
    if (dims?.height) q.set("h", String(Math.round(dims.height)));
    if (dims?.duration) q.set("d", String(Math.round(dims.duration)));

    // XHR rather than fetch: upload progress is the one thing fetch still
    // cannot report, and a silent progress bar on a 20 MB video is no bar.
    return new Promise<UploadJSON>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.baseUrl}/api/v1/uploads?${q}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      if (this.token) xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          let code = `http_${xhr.status}`;
          try {
            code = (JSON.parse(xhr.responseText) as { error?: string }).error ?? code;
          } catch {
            /* non-JSON error body */
          }
          reject(new ApiError(xhr.status, code));
          return;
        }
        resolve((JSON.parse(xhr.responseText) as { upload: UploadJSON }).upload);
      };
      xhr.onerror = () => reject(new ApiError(0, "network"));
      xhr.send(data as BufferSource);
    });
  }

  async download(id: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/api/v1/uploads/${id}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async uploadAvatar(mime: string, data: Uint8Array): Promise<UploadJSON> {
    const res = await fetch(`${this.baseUrl}/api/v1/uploads/avatar?mime=${encodeURIComponent(mime)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: data as BodyInit,
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        code = ((await res.json()) as { error?: string }).error ?? code;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return ((await res.json()) as { upload: UploadJSON }).upload;
  }

  /** Avatars need the bearer token, so they are fetched and turned into blobs
   *  rather than dropped straight into an `img src`. */
  async avatarBlob(id: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/v1/avatars/${id}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, `http_${res.status}`);
    return res.blob();
  }

  // ------------------------------------------- pins, threads, chat state

  pinMessage(id: string): Promise<void> {
    return this.request("POST", `/api/v1/messages/${id}/pin`);
  }

  unpinMessage(id: string): Promise<void> {
    return this.request("DELETE", `/api/v1/messages/${id}/pin`);
  }

  pinnedMessages(channelId: string): Promise<{ messages: MessageJSON[] }> {
    return this.request("GET", `/api/v1/channels/${channelId}/pinned`);
  }

  setMembership(
    channelId: string,
    flags: { archived?: boolean; pinned?: boolean; muted?: boolean },
  ): Promise<{ archived: boolean; pinned: boolean; muted: boolean }> {
    return this.request("PATCH", `/api/v1/channels/${channelId}/membership`, flags);
  }

  setChannelTTL(id: string, ttlSeconds: number): Promise<{ ttlSeconds: number }> {
    return this.request("PATCH", `/api/v1/channels/${id}/ttl`, { ttlSeconds });
  }

  clearHistory(channelId: string): Promise<{ removed: number }> {
    return this.request("POST", `/api/v1/channels/${channelId}/clear`);
  }

  threads(channelId: string): Promise<{ threads: ChannelJSON[] }> {
    return this.request("GET", `/api/v1/channels/${channelId}/threads`);
  }

  createThread(
    channelId: string,
    input: { name: string; topic: string; members: string[]; suite: string },
  ): Promise<{ thread: ChannelJSON }> {
    return this.request("POST", `/api/v1/channels/${channelId}/threads`, input);
  }

  updateChannel(
    id: string,
    input: { name: string; topic: string; avatar?: string | null },
  ): Promise<{ channel: ChannelJSON }> {
    return this.request("PATCH", `/api/v1/channels/${id}`, {
      name: input.name,
      topic: input.topic,
      ...(input.avatar === undefined ? {} : { avatar: input.avatar ?? "" }),
    });
  }

  // ------------------------------------------------------------ calls

  ice(): Promise<IceConfig> {
    return this.request("GET", "/api/v1/ice");
  }

  // ------------------------------------------------------------ admin

  adminOverview(): Promise<AdminOverview> {
    return this.request("GET", "/api/v1/admin/overview");
  }

  adminUsers(): Promise<{ users: AdminUserRow[] }> {
    return this.request("GET", "/api/v1/admin/users");
  }

  adminChannels(): Promise<{ channels: AdminChannelRow[] }> {
    return this.request("GET", "/api/v1/admin/channels");
  }

  adminSetFlags(
    id: string,
    flags: { isAdmin?: boolean; suspended?: boolean },
  ): Promise<{ user: User }> {
    return this.request("POST", `/api/v1/admin/users/${id}/flags`, flags);
  }

  adminCompact(): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/v1/admin/compact");
  }

  deleteMessage(id: string): Promise<void> {
    return this.request("DELETE", `/api/v1/messages/${id}`);
  }

  // ------------------------------------------------------------ realtime

  onEvent(fn: (ev: WsEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnectionChange(fn: (online: boolean) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  connect(): void {
    if (!this.token || this.socket) return;
    this.closed = false;

    const url = new URL(this.baseUrl + "/api/v1/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", this.token);

    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = 1000;
      for (const fn of this.statusListeners) fn(true);
    };
    socket.onmessage = (raw) => {
      let ev: WsEvent;
      try {
        ev = JSON.parse(raw.data as string) as WsEvent;
      } catch {
        return;
      }
      for (const fn of this.listeners) fn(ev);
    };
    socket.onclose = () => {
      this.socket = null;
      for (const fn of this.statusListeners) fn(false);
      if (this.closed || !this.token) return;
      // Back off, but never so far that a laptop waking up feels dead.
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(delay * 2, 15000);
      setTimeout(() => this.connect(), delay);
    };
    socket.onerror = () => socket.close();
  }

  disconnect(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  sendTyping(channelId: string): void {
    this.push({ type: "typing", channel: channelId });
  }

  /** Fire-and-forget socket write, used by call signalling. */
  push(message: { type: string; channel?: string; data?: unknown }): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
