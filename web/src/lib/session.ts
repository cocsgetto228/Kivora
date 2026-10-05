/**
 * The client core: everything between "the user did something" and "opaque
 * bytes went to the server", plus the same path in reverse.
 *
 * This is the only place in the web client that holds private keys or sees
 * plaintext. The UI reads a snapshot of state and calls actions; it never
 * touches the crypto package directly. Keeping that boundary sharp is what
 * makes the security claims checkable — the surface to audit is this file.
 */

import {
  createDeviceKeys,
  decodePayload,
  deserializeSecrets,
  encodePayload,
  defaultSuiteId,
  forgetPreKey,
  fromBase64,
  getSuite,
  listSuites,
  openFile,
  openSealed,
  replenishPreKeys,
  rewrapFor,
  safetyNumber,
  seal,
  sealFile,
  serializeSecrets,
  setDefaultSuite,
  toBase64,
  toDeviceRecord,
  TrustStore,
  unwrapContentKey,
  deviceFingerprint,
  type AttachmentPayload,
  type DeviceRecord,
  type DeviceSecrets,
  type TrustState,
} from "@kivora/crypto";

import {
  Api,
  describeError,
  type AdminChannelRow,
  type AdminOverview,
  type AdminUserRow,
  type CallRoom,
  type ChannelJSON,
  type DeviceJSON,
  type Member,
  type MessageJSON,
  type ServerInfo,
  type User,
  type WsEvent,
} from "./api.ts";
import { Vault, type VaultBackend } from "./vault.ts";
import { CallManager, type CallSnapshot } from "./calls.ts";
import {
  coreInfo,
  deviceSecret,
  forgetDevice,
  isDesktop,
  noteUnlockFailure,
  noteUnlockSuccess,
  unlockDelay,
  type CoreInfo,
} from "./desktop.ts";
import { getLang, setLang, t, type Lang } from "../i18n/index.ts";

const TOKEN_KEY = "kivora.token";
const ACCOUNT_KEY = "kivora.account";
const SERVER_KEY = "kivora.server";
const THEME_KEY = "kivora.theme";
const SUITE_KEY = "kivora.suite";

export type Phase = "loading" | "signed-out" | "locked" | "ready";
export type Connection = "offline" | "connecting" | "online";
export type View = "chats" | "channels" | "archive" | "settings" | "notfound";

/** Which page of the admin console is open. */
export type AdminTab = "overview" | "users" | "channels" | "security" | "pages";

/**
 * Where the address bar points.
 *
 * The messenger and the admin console are two different products sharing one
 * bundle: the console has its own chrome, its own audience and its own URL, and
 * a chat rail has no business appearing over it. `preview404` exists so an
 * operator can look at the error page without having to invent a broken link.
 */
export type Route =
  | { kind: "app" }
  | { kind: "admin"; tab: AdminTab }
  | { kind: "preview404" }
  | { kind: "notfound" };

export interface DecryptedMessage {
  id: string;
  channelId: string;
  seq: number;
  senderId: string;
  senderDevice: string;
  createdAt: number;
  editedAt: number;
  deleted: boolean;
  pinned: boolean;
  kind: string;
  text?: string;
  attachments?: AttachmentPayload[];
  replyTo?: string;
  /** Why it could not be read, if it could not. */
  problem?: string;
  pending?: boolean;
  failed?: boolean;
  /** Progress of an in-flight upload, 0..1. */
  uploading?: number;
}

export interface IncomingCall {
  channelId: string;
  fromId: string;
  fromName: string;
  video: boolean;
  at: number;
}

export interface SuiteInfo {
  id: string;
  label: string;
  keyLength: number;
  nonceLength: number;
  signatures: boolean;
  notes?: string;
  allowed: boolean;
  isDefault: boolean;
}

export interface SessionState {
  phase: Phase;
  connection: Connection;
  view: View;
  /** What the address bar points at. See parseRoute. */
  route: Route;
  server: ServerInfo | null;
  serverUrl: string;
  user: User | null;
  deviceId: string | null;
  suiteId: string;
  suiteBackend: string;
  suites: SuiteInfo[];
  channels: ChannelJSON[];
  browse: ChannelJSON[];
  activeChannelId: string | null;
  threads: Record<string, ChannelJSON[]>;
  messages: Record<string, DecryptedMessage[]>;
  pinned: Record<string, DecryptedMessage[]>;
  typing: Record<string, string[]>;
  online: string[];
  devices: DeviceJSON[];
  trust: Record<string, TrustState>;
  call: CallSnapshot | null;
  incoming: IncomingCall | null;
  activeRooms: CallRoom[];
  notice: string | null;
  busy: boolean;
  theme: "dark" | "light";
  lang: Lang;
  core: CoreInfo | null;
}

type Listener = () => void;

export class Session {
  readonly api: Api;
  readonly calls: CallManager;

  private vault: Vault;
  private secrets: DeviceSecrets | null = null;
  private trust = new TrustStore();
  private password: string | null = null;
  private listeners = new Set<Listener>();

  /** Public keys of every device we have seen. */
  private directory = new Map<string, DeviceRecord>();
  private bootstrapped = new Set<string>();
  private typingTimers = new Map<string, number>();
  /** Decrypted attachments, kept as object URLs for the lifetime of the tab. */
  private blobUrls = new Map<string, string>();
  private avatarUrls = new Map<string, string>();
  private inFlightAvatars = new Map<string, Promise<string | null>>();

  private state: SessionState;

  constructor(serverUrl?: string, backend?: VaultBackend) {
    const url = serverUrl ?? localStorage.getItem(SERVER_KEY) ?? window.location.origin;
    this.api = new Api(url);
    this.vault = new Vault(backend, "kivora.vault", deviceSecret);
    this.calls = new CallManager(this.api, () => this.state.deviceId ?? "");

    this.state = {
      phase: "loading",
      connection: "offline",
      view: "chats",
      route: { kind: "app" },
      server: null,
      serverUrl: url,
      user: null,
      deviceId: null,
      suiteId: localStorage.getItem(SUITE_KEY) ?? defaultSuiteId(),
      suiteBackend: "",
      suites: [],
      channels: [],
      browse: [],
      activeChannelId: null,
      threads: {},
      messages: {},
      pinned: {},
      typing: {},
      online: [],
      devices: [],
      trust: {},
      call: null,
      incoming: null,
      activeRooms: [],
      notice: null,
      busy: false,
      theme: (localStorage.getItem(THEME_KEY) as "dark" | "light") ?? "dark",
      lang: getLang(),
      core: null,
    };

    this.calls.subscribe((snapshot) => this.set({ call: snapshot }));

    // Anything the router does not recognise gets the 404 screen rather than a
    // silent redirect: a redirect hides the broken link from whoever made it.
    this.state.route = parseRoute(window.location.pathname);
    window.addEventListener("popstate", () => {
      this.set({ route: parseRoute(window.location.pathname) });
    });
  }

  // ------------------------------------------------------------ store glue

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): SessionState => this.state;

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private notice(text: string | null): void {
    this.set({ notice: text });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  setView(view: View): void {
    if (this.state.route.kind !== "app") this.navigate("/", { replace: true });
    this.set({ view });
    if (view === "channels") void this.refreshBrowse();
    if (view === "settings") void this.refreshDevices();
  }

  /** The logo in the corner: always a way back to the full chat list. */
  goHome(): void {
    this.navigate("/", { replace: this.state.route.kind === "notfound" });
    this.set({ view: "chats", activeChannelId: null });
  }

  /**
   * Move to a path and update the route. Everything that changes the address
   * goes through here, so the address bar and the rendered page cannot disagree
   * — which is the usual way a hand-rolled router rots.
   */
  navigate(path: string, opts: { replace?: boolean } = {}): void {
    if (window.location.pathname !== path) {
      if (opts.replace) window.history.replaceState(null, "", path);
      else window.history.pushState(null, "", path);
    }
    this.set({ route: parseRoute(path) });
  }

  openAdmin(tab: AdminTab = "overview"): void {
    this.navigate(tab === "overview" ? "/admin" : `/admin/${tab}`);
  }

  // ------------------------------------------------------------ lifecycle

  async boot(): Promise<void> {
    try {
      const server = await this.api.serverInfo();
      const suiteId = this.pickSuite(server);
      const backend = (await getSuite(suiteId).backend?.()) ?? "portable";
      this.set({ server, suiteId, suiteBackend: backend, suites: this.describeSuites(server, suiteId) });
    } catch (err) {
      this.set({
        phase: "signed-out",
        notice: t("auth.serverUnreachable", { reason: describeError(err) }),
      });
      return;
    }

    const account = localStorage.getItem(ACCOUNT_KEY);
    if (isDesktop() && account) this.set({ core: await coreInfo(account) });

    const token = localStorage.getItem(TOKEN_KEY);
    if (!token || !account) {
      this.set({ phase: "signed-out" });
      return;
    }
    this.api.setToken(token);
    try {
      const { user } = await this.api.me();
      this.set({ user, phase: (await this.vault.exists(account)) ? "locked" : "signed-out" });
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      this.api.setToken(null);
      this.set({ phase: "signed-out" });
    }
  }

  private pickSuite(server: ServerInfo): string {
    const mine = listSuites().map((s) => s.id);
    const allowed = (id: string) =>
      server.allowedSuites.includes("*") || server.allowedSuites.includes(id);

    const remembered = localStorage.getItem(SUITE_KEY);
    if (remembered && mine.includes(remembered) && allowed(remembered)) return remembered;

    const recommended = server.suites.find((s) => s.recommended && mine.includes(s.id) && allowed(s.id));
    if (recommended) return recommended.id;
    const fallback = mine.find(allowed);
    if (!fallback) throw new Error(t("error.noSuite"));
    return fallback;
  }

  private describeSuites(server: ServerInfo, activeId: string): SuiteInfo[] {
    const allowed = (id: string) =>
      server.allowedSuites.includes("*") || server.allowedSuites.includes(id);
    return listSuites().map((suite) => ({
      id: suite.id,
      label: suite.label,
      keyLength: suite.keyLength,
      nonceLength: suite.nonceLength,
      signatures: suite.signatures,
      notes: suite.notes,
      allowed: allowed(suite.id),
      isDefault: suite.id === activeId,
    }));
  }

  /**
   * Choosing the default suite affects chats created *from now on*. Existing
   * chats keep the suite they were created with — swapping it live would be a
   * downgrade path, which is the one thing a negotiated protocol must not have.
   */
  chooseSuite(id: string): void {
    if (!this.state.server) return;
    setDefaultSuite(id);
    localStorage.setItem(SUITE_KEY, id);
    this.set({ suiteId: id, suites: this.describeSuites(this.state.server, id) });
  }

  setServerUrl(url: string): void {
    localStorage.setItem(SERVER_KEY, url);
    location.reload();
  }

  toggleTheme(): void {
    const theme = this.state.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
    this.set({ theme });
  }

  chooseLanguage(lang: Lang | null): void {
    setLang(lang);
    this.set({ lang: getLang() });
  }

  // ------------------------------------------------------------ auth

  async register(input: {
    username: string;
    displayName: string;
    password: string;
    inviteCode?: string;
  }): Promise<void> {
    this.set({ busy: true, notice: null });
    try {
      const { token, user } = await this.api.register(input);
      this.api.setToken(token);
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(ACCOUNT_KEY, user.username);
      this.password = input.password;
      await this.provisionDevice(input.password);
      this.set({ user });
      await this.enter();
    } catch (err) {
      this.set({ busy: false, notice: describeError(err) });
      throw err;
    }
  }

  async login(username: string, password: string): Promise<void> {
    this.set({ busy: true, notice: null });
    try {
      const { token, user } = await this.api.login(username, password);
      this.api.setToken(token);
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(ACCOUNT_KEY, user.username);
      this.password = password;
      this.set({ user });
      await this.restoreOrProvision(username, password);
      await this.enter();
    } catch (err) {
      this.set({ busy: false, notice: describeError(err) });
      throw err;
    }
  }

  async unlock(password: string): Promise<void> {
    const account = localStorage.getItem(ACCOUNT_KEY);
    if (!account) {
      this.set({ phase: "signed-out" });
      return;
    }
    const wait = await unlockDelay(account);
    if (wait > 0) {
      this.set({ notice: t("auth.throttled", { seconds: wait }) });
      throw new Error("throttled");
    }

    this.set({ busy: true, notice: null });
    try {
      this.password = password;
      await this.restoreOrProvision(account, password);
      await noteUnlockSuccess(account);
      await this.enter();
    } catch (err) {
      this.password = null;
      const delay = await noteUnlockFailure(account);
      this.set({
        busy: false,
        notice:
          delay > 0
            ? t("auth.nextAttempt", { reason: describeError(err), seconds: delay })
            : describeError(err),
      });
      throw err;
    }
  }

  private async restoreOrProvision(account: string, password: string): Promise<void> {
    const stored = await this.vault.unseal(account, password);
    if (!stored) {
      await this.provisionDevice(password);
      return;
    }
    const { secrets, trust } = parseVault(stored);
    try {
      const { preKeysAvailable } = await this.api.attachDevice(secrets.deviceId);
      this.secrets = secrets;
      this.trust = trust;
      this.set({ deviceId: secrets.deviceId, suiteId: secrets.suite });
      if (preKeysAvailable < 15) await this.topUpPreKeys();
    } catch {
      await this.provisionDevice(password);
      this.notice(t("error.deviceRevoked"));
    }
  }

  private async provisionDevice(password: string): Promise<void> {
    const suiteId = this.state.suiteId;
    const { secrets, published } = await createDeviceKeys(suiteId);
    const { device } = await this.api.registerDevice({
      name: describeThisDevice(),
      platform: detectPlatform(),
      ...published,
    });
    secrets.deviceId = device.id;
    this.secrets = secrets;
    await this.persistVault(password);
    this.set({ deviceId: device.id, suiteId });
  }

  /** Re-seals the vault. Needs the password, which is only in memory while the
   *  session is unlocked; without it the pre-key top-up simply repeats later. */
  private async persistVault(password?: string): Promise<void> {
    const account = localStorage.getItem(ACCOUNT_KEY);
    const secret = password ?? this.password;
    if (!account || !secret || !this.secrets) return;
    await this.vault.seal(
      account,
      secret,
      JSON.stringify({ v: 2, secrets: serializeSecrets(this.secrets), trust: this.trust.serialize() }),
    );
  }

  private async topUpPreKeys(): Promise<void> {
    if (!this.secrets) return;
    const fresh = await replenishPreKeys(this.secrets);
    await this.api.uploadPreKeys(fresh);
    await this.persistVault();
  }

  private async enter(): Promise<void> {
    this.set({ phase: "ready", busy: false, connection: "connecting", view: "chats" });
    this.api.onEvent(this.handleEvent);
    this.api.onConnectionChange((online) => this.set({ connection: online ? "online" : "offline" }));
    this.api.connect();
    await this.refreshChannels();
    void this.refreshDevices();
  }

  async signOut(): Promise<void> {
    await this.calls.hangUp();
    try {
      await this.api.logout();
    } catch {
      /* signing out locally matters more than telling the server */
    }
    this.api.disconnect();
    this.api.setToken(null);
    localStorage.removeItem(TOKEN_KEY);
    this.secrets = null;
    this.password = null;
    this.directory.clear();
    this.releaseBlobs();
    this.set({
      phase: "signed-out",
      view: "chats",
      user: null,
      deviceId: null,
      channels: [],
      messages: {},
      pinned: {},
      activeChannelId: null,
      connection: "offline",
    });
  }

  async forgetThisDevice(): Promise<void> {
    const account = localStorage.getItem(ACCOUNT_KEY);
    if (account) {
      await this.vault.clear(account);
      await forgetDevice(account);
    }
    await this.signOut();
  }

  private releaseBlobs(): void {
    for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
    for (const url of this.avatarUrls.values()) URL.revokeObjectURL(url);
    this.blobUrls.clear();
    this.avatarUrls.clear();
  }

  // ------------------------------------------------------------ channels

  async refreshChannels(): Promise<void> {
    const { channels, online } = await this.api.listChannels();
    this.set({ channels, online });
  }

  async refreshBrowse(): Promise<void> {
    const { channels } = await this.api.browseChannels();
    this.set({ browse: channels });
  }

  async refreshDevices(): Promise<void> {
    const { devices } = await this.api.listDevices();
    this.set({ devices });
  }

  async openChannel(channelId: string): Promise<void> {
    this.set({ activeChannelId: channelId, view: this.state.view === "archive" ? "archive" : this.state.view });
    await this.loadDirectory(channelId);

    const { messages } = await this.api.history(channelId, undefined, 60);
    const decrypted = await Promise.all(messages.map((m) => this.decrypt(channelId, m)));
    this.set({ messages: { ...this.state.messages, [channelId]: decrypted } });

    void this.loadPinned(channelId);
    void this.loadThreads(channelId);

    const channel = this.state.channels.find((c) => c.id === channelId);
    const last = messages.at(-1);
    if (channel && last && last.seq > channel.lastReadSeq) {
      await this.api.markRead(channelId, last.seq);
      this.set({
        channels: this.state.channels.map((c) =>
          c.id === channelId ? { ...c, unread: 0, lastReadSeq: last.seq } : c,
        ),
      });
    }
  }

  async loadOlder(channelId: string): Promise<void> {
    const known = this.state.messages[channelId] ?? [];
    const oldest = known.find((m) => !m.pending)?.seq;
    if (!oldest || oldest <= 1) return;
    const { messages } = await this.api.history(channelId, oldest, 50);
    if (messages.length === 0) return;
    const decrypted = await Promise.all(messages.map((m) => this.decrypt(channelId, m)));
    this.set({ messages: { ...this.state.messages, [channelId]: [...decrypted, ...known] } });
  }

  async startDirect(userId: string): Promise<string> {
    const { channel } = await this.api.openDirect(userId, this.state.suiteId);
    await this.refreshChannels();
    await this.openChannel(channel.id);
    return channel.id;
  }

  async createChannel(input: {
    kind: "group" | "channel";
    name: string;
    topic: string;
    members: string[];
    encrypted: boolean;
    suite?: string;
  }): Promise<string> {
    const { channel } = await this.api.createChannel({
      ...input,
      suite: input.suite ?? this.state.suiteId,
    });
    await this.refreshChannels();
    await this.openChannel(channel.id);
    return channel.id;
  }

  async joinChannel(channelId: string): Promise<void> {
    await this.api.joinChannel(channelId);
    await this.refreshChannels();
    await this.refreshBrowse();
    await this.openChannel(channelId);
  }

  async leaveChannel(channelId: string): Promise<void> {
    await this.api.leaveChannel(channelId);
    const messages = { ...this.state.messages };
    delete messages[channelId];
    this.set({ activeChannelId: null, messages });
    await this.refreshChannels();
  }

  async addMember(channelId: string, userId: string): Promise<void> {
    await this.api.addMember(channelId, userId);
    this.directory.clear();
    await this.loadDirectory(channelId);
    await this.refreshChannels();
  }

  searchUsers(q: string): Promise<{ users: Member[] }> {
    return this.api.searchUsers(q);
  }

  // ----------------------------------------------- personal chat state

  async setChatFlags(
    channelId: string,
    flags: { archived?: boolean; pinned?: boolean; muted?: boolean },
  ): Promise<void> {
    const applied = await this.api.setMembership(channelId, flags);
    this.set({
      channels: this.state.channels.map((c) => (c.id === channelId ? { ...c, ...applied } : c)),
    });
    if (applied.archived && this.state.activeChannelId === channelId && this.state.view !== "archive") {
      this.set({ activeChannelId: null });
    }
  }

  /**
   * Turn disappearing messages on or off for a chat.
   *
   * The timer is a property of the chat, so it applies to both sides — a timer
   * that only cleared your own copy would be a comfort, not a feature.
   */
  async setChannelTTL(channelId: string, ttlSeconds: number): Promise<void> {
    await this.api.setChannelTTL(channelId, ttlSeconds);
    await this.refreshChannels();
  }

  async clearHistory(channelId: string): Promise<void> {
    await this.api.clearHistory(channelId);
    await this.openChannel(channelId);
  }

  async markRead(channelId: string): Promise<void> {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel || channel.lastSeq <= channel.lastReadSeq) return;
    await this.api.markRead(channelId, channel.lastSeq);
    await this.refreshChannels();
  }

  /**
   * Exports a conversation as JSON, decrypted on this device. It is a plain
   * file the user then owns — which is worth saying out loud in the UI, because
   * an exported archive has none of the protections the chat had.
   */
  async exportChannel(channelId: string): Promise<string> {
    const channel = this.state.channels.find((c) => c.id === channelId);
    const { messages } = await this.api.history(channelId, undefined, 5000);
    const decrypted = await Promise.all(messages.map((m) => this.decrypt(channelId, m)));
    const members = new Map((channel?.members ?? []).map((m) => [m.userId, m]));

    const archive = {
      exportedAt: new Date().toISOString(),
      server: this.state.serverUrl,
      channel: {
        id: channelId,
        kind: channel?.kind,
        name: channel?.name,
        topic: channel?.topic,
        encrypted: channel?.encrypted,
        suite: channel?.suite,
      },
      participants: channel?.members ?? [],
      messages: decrypted
        .filter((m) => !m.deleted)
        .map((m) => ({
          at: new Date(m.createdAt).toISOString(),
          from: members.get(m.senderId)?.displayName ?? m.senderId,
          username: members.get(m.senderId)?.username,
          text: m.text ?? "",
          pinned: m.pinned || undefined,
          attachments: m.attachments?.map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
          unreadable: m.problem || undefined,
        })),
    };

    const name = `kivora-${(channel?.name || channel?.kind || "chat").replace(/[^\p{L}\p{N}-]+/gu, "-")}-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    downloadBlob(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }), name);
    return name;
  }

  // --------------------------------------------------------------- pins

  async loadPinned(channelId: string): Promise<void> {
    try {
      const { messages } = await this.api.pinnedMessages(channelId);
      const decrypted = await Promise.all(messages.map((m) => this.decrypt(channelId, m)));
      this.set({ pinned: { ...this.state.pinned, [channelId]: decrypted } });
    } catch {
      /* pins are a convenience; failing to load them must not break the chat */
    }
  }

  async setPinned(channelId: string, messageId: string, pinned: boolean): Promise<void> {
    if (pinned) await this.api.pinMessage(messageId);
    else await this.api.unpinMessage(messageId);
    this.set({
      messages: {
        ...this.state.messages,
        [channelId]: (this.state.messages[channelId] ?? []).map((m) =>
          m.id === messageId ? { ...m, pinned } : m,
        ),
      },
    });
    await this.loadPinned(channelId);
    await this.refreshChannels();
  }

  // ------------------------------------------------------------ threads

  async loadThreads(channelId: string): Promise<void> {
    const channel = this.state.channels.find((c) => c.id === channelId);
    if (!channel || (channel.kind !== "group" && channel.kind !== "channel")) return;
    try {
      const { threads } = await this.api.threads(channelId);
      this.set({ threads: { ...this.state.threads, [channelId]: threads } });
    } catch {
      /* ignore */
    }
  }

  async createThread(
    parentId: string,
    input: { name: string; topic: string; members: string[]; suite?: string },
  ): Promise<string> {
    const { thread } = await this.api.createThread(parentId, {
      ...input,
      suite: input.suite ?? this.state.suiteId,
    });
    await this.refreshChannels();
    await this.loadThreads(parentId);
    await this.openChannel(thread.id);
    return thread.id;
  }

  /**
   * The suite a chat actually uses. A conversation keeps the suite it was
   * created with for its whole life — that is what makes "add your own cipher
   * per chat" safe, because nothing can renegotiate an existing chat downwards.
   */
  suiteFor(channelId: string): string {
    return this.channelById(channelId)?.suite || this.state.suiteId;
  }

  /** Threads are not in the sidebar, so the header needs their parent by hand. */
  channelById(id: string | null | undefined): ChannelJSON | undefined {
    if (!id) return undefined;
    const direct = this.state.channels.find((c) => c.id === id);
    if (direct) return direct;
    for (const list of Object.values(this.state.threads)) {
      const thread = list.find((c) => c.id === id);
      if (thread) return thread;
    }
    return undefined;
  }

  // ------------------------------------------------------------ messaging

  private async loadDirectory(channelId: string): Promise<void> {
    const { devices } = await this.api.channelDevices(channelId);
    for (const d of devices) this.directory.set(d.id, toDeviceRecord(d));
    this.refreshTrust(devices);

    const users = new Set(devices.filter((d) => !this.bootstrapped.has(d.id)).map((d) => d.userId));
    for (const userId of users) {
      try {
        const { bundles } = await this.api.keyBundles(userId);
        for (const b of bundles) {
          this.directory.set(
            b.device.id,
            toDeviceRecord({ ...b.device, preKeyId: b.preKeyId, preKey: b.preKey }),
          );
          this.bootstrapped.add(b.device.id);
        }
      } catch {
        /* fall back to the signed pre-key */
      }
    }
  }

  /**
   * Compare every device we just learned about against what this machine has
   * previously verified. A changed key is surfaced, never silently accepted.
   */
  private refreshTrust(devices: DeviceJSON[]): void {
    const next = { ...this.state.trust };
    let changed = false;
    for (const device of devices) {
      if (device.userId === this.state.user?.id) continue;
      const identity = fromBase64(device.identityPub);
      const state = this.trust.inspect(device.userId, identity);
      if (state === "changed") this.trust.noteChange(device.userId, identity);
      if (next[device.userId] !== state) {
        next[device.userId] = state;
        changed = true;
      }
    }
    if (changed) {
      this.set({ trust: next });
      void this.persistVault();
    }
  }

  async sendMessage(
    channelId: string,
    text: string,
    options: { files?: File[]; replyTo?: string } = {},
  ): Promise<void> {
    const body = text.trim();
    const files = options.files ?? [];
    if ((!body && files.length === 0) || !this.secrets) return;

    const clientId = crypto.randomUUID();
    const optimistic: DecryptedMessage = {
      id: clientId,
      channelId,
      seq: Number.MAX_SAFE_INTEGER,
      senderId: this.state.user!.id,
      senderDevice: this.secrets.deviceId,
      createdAt: Date.now(),
      editedAt: 0,
      deleted: false,
      pinned: false,
      kind: files.length > 0 ? "media" : "text",
      text: body,
      replyTo: options.replyTo,
      pending: true,
      uploading: files.length > 0 ? 0 : undefined,
    };
    this.appendMessage(channelId, optimistic);

    try {
      const attachments: AttachmentPayload[] = [];
      for (let i = 0; i < files.length; i++) {
        const attachment = await this.uploadOne(channelId, files[i]!, (fraction) => {
          this.patchMessage(channelId, clientId, {
            uploading: (i + fraction) / files.length,
          });
        });
        attachments.push(attachment);
      }
      this.patchMessage(channelId, clientId, { uploading: undefined });

      if (this.directory.size === 0) await this.loadDirectory(channelId);
      const recipients = [...this.directory.values()].filter((d) =>
        this.channelDeviceIds(channelId).has(d.deviceId),
      );

      const payload = encodePayload({
        text: body,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      const sealed = await seal(this.suiteFor(channelId), channelId, this.secrets, recipients, payload);

      const keys: Record<string, string> = {};
      for (const [deviceId, wrapped] of Object.entries(sealed.keys)) keys[deviceId] = toBase64(wrapped);

      const { message } = await this.api.send(channelId, {
        kind: attachments.length > 0 ? "media" : "text",
        suite: this.suiteFor(channelId),
        header: toBase64(sealed.header),
        body: toBase64(sealed.body),
        keys,
        replyTo: options.replyTo,
        clientId,
        attachments: attachments.map((a) => a.id),
      });

      this.replaceMessage(channelId, clientId, {
        ...optimistic,
        id: message.id,
        seq: message.seq,
        createdAt: message.createdAt,
        attachments: attachments.length > 0 ? attachments : undefined,
        pending: false,
        uploading: undefined,
      });

      for (const record of recipients) {
        if (record.preKeyId) {
          this.directory.set(record.deviceId, { ...record, preKeyId: undefined, preKey: undefined });
        }
      }
      await this.refreshChannels();
    } catch (err) {
      this.patchMessage(channelId, clientId, { pending: false, failed: true, uploading: undefined });
      this.notice(describeError(err));
    }
  }

  /** Encrypts a file locally, then uploads the ciphertext. */
  private async uploadOne(
    channelId: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<AttachmentPayload> {
    const suiteId = this.suiteFor(channelId);
    const raw = new Uint8Array(await file.arrayBuffer());
    const dimensions = await measure(file);
    const sealedFile = await sealFile(suiteId, channelId, raw);

    const upload = await this.api.upload(
      channelId,
      file.type || "application/octet-stream",
      sealedFile.ciphertext,
      dimensions,
      onProgress,
    );

    // Keep the plaintext we already have so the sender sees the picture
    // immediately instead of downloading back what they just sent.
    this.blobUrls.set(upload.id, URL.createObjectURL(new Blob([raw as BlobPart], { type: file.type })));

    return {
      id: upload.id,
      kind: attachmentKind(file.type),
      mime: file.type || "application/octet-stream",
      name: file.name,
      size: raw.length,
      width: dimensions.width,
      height: dimensions.height,
      duration: dimensions.duration,
      thumb: dimensions.thumb,
      key: sealedFile.key,
    };
  }

  /** Returns an object URL for a decrypted attachment, fetching it once. */
  async attachmentUrl(channelId: string, attachment: AttachmentPayload): Promise<string> {
    const cached = this.blobUrls.get(attachment.id);
    if (cached) return cached;

    const ciphertext = await this.api.download(attachment.id);
    const plain = await openFile(attachment.key, channelId, ciphertext);
    const url = URL.createObjectURL(new Blob([plain as BlobPart], { type: attachment.mime }));
    this.blobUrls.set(attachment.id, url);
    return url;
  }

  async saveAttachment(channelId: string, attachment: AttachmentPayload): Promise<void> {
    const url = await this.attachmentUrl(channelId, attachment);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.name || "file";
    link.click();
  }

  private channelDeviceIds(channelId: string): Set<string> {
    const channel = this.channelById(channelId);
    const memberIds = new Set((channel?.members ?? []).map((m) => m.userId));
    const ids = new Set<string>();
    for (const [id, record] of this.directory) {
      if (memberIds.size === 0 || memberIds.has(record.userId)) ids.add(id);
    }
    return ids;
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.api.deleteMessage(messageId);
    this.set({
      messages: {
        ...this.state.messages,
        [channelId]: (this.state.messages[channelId] ?? []).map((m) =>
          m.id === messageId ? { ...m, deleted: true, text: undefined, attachments: undefined } : m,
        ),
      },
    });
    void this.loadPinned(channelId);
  }

  notifyTyping(channelId: string): void {
    this.api.sendTyping(channelId);
  }

  // ------------------------------------------------------------ avatars

  /** Resolves an avatar id to a blob URL, fetching each one at most once. */
  avatarUrl(id: string | undefined | null): string | null {
    if (!id) return null;
    const cached = this.avatarUrls.get(id);
    if (cached) return cached;
    if (!this.inFlightAvatars.has(id)) {
      const promise = this.api
        .avatarBlob(id)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          this.avatarUrls.set(id, url);
          this.inFlightAvatars.delete(id);
          // A late arrival still has to reach the screen.
          this.set({});
          return url;
        })
        .catch(() => {
          this.inFlightAvatars.delete(id);
          return null;
        });
      this.inFlightAvatars.set(id, promise);
    }
    return null;
  }

  async setMyAvatar(file: File | null): Promise<void> {
    const user = this.state.user;
    if (!user) return;
    if (!file) {
      const { user: updated } = await this.api.updateProfile(user.displayName, user.bio, null);
      this.set({ user: updated });
      await this.refreshChannels();
      return;
    }
    const prepared = await prepareAvatar(file);
    const upload = await this.api.uploadAvatar(prepared.mime, prepared.data);
    const { user: updated } = await this.api.updateProfile(user.displayName, user.bio, upload.id);
    this.avatarUrls.set(upload.id, URL.createObjectURL(new Blob([prepared.data as BlobPart], { type: prepared.mime })));
    this.set({ user: updated });
    await this.refreshChannels();
  }

  async setChannelAvatar(channelId: string, file: File | null): Promise<void> {
    const channel = this.channelById(channelId);
    if (!channel) return;
    let avatar: string | null = null;
    if (file) {
      const prepared = await prepareAvatar(file);
      const upload = await this.api.uploadAvatar(prepared.mime, prepared.data);
      avatar = upload.id;
      this.avatarUrls.set(
        upload.id,
        URL.createObjectURL(new Blob([prepared.data as BlobPart], { type: prepared.mime })),
      );
    }
    await this.api.updateChannel(channelId, { name: channel.name, topic: channel.topic, avatar });
    await this.refreshChannels();
  }

  async updateChannelMeta(channelId: string, name: string, topic: string): Promise<void> {
    await this.api.updateChannel(channelId, { name, topic });
    await this.refreshChannels();
  }

  // ------------------------------------------------------------ decryption

  private async decrypt(channelId: string, raw: MessageJSON): Promise<DecryptedMessage> {
    const base: DecryptedMessage = {
      id: raw.id,
      channelId,
      seq: raw.seq,
      senderId: raw.senderId,
      senderDevice: raw.senderDevice,
      createdAt: raw.createdAt,
      editedAt: raw.editedAt,
      deleted: raw.deleted,
      pinned: raw.pinned,
      kind: raw.kind,
      replyTo: raw.replyTo,
    };
    if (raw.deleted) return base;
    if (!this.secrets) return { ...base, problem: t("error.noKeys") };
    if (!raw.wrappedKey) return { ...base, problem: t("error.historyGap") };

    let sender = this.directory.get(raw.senderDevice);
    if (!sender) {
      await this.loadDirectory(channelId);
      sender = this.directory.get(raw.senderDevice);
    }
    if (!sender) return { ...base, problem: t("error.unknownSender") };

    try {
      const plaintext = await openSealed({
        channelId,
        header: fromBase64(raw.header ?? ""),
        body: fromBase64(raw.body),
        wrappedKey: fromBase64(raw.wrappedKey),
        senderDevice: sender,
        recipient: this.secrets,
      });
      const payload = decodePayload(plaintext);
      return { ...base, text: payload.text, attachments: payload.attachments };
    } catch (err) {
      return { ...base, problem: err instanceof Error ? err.message : t("chat.undecryptable") };
    }
  }

  async shareHistory(targetDeviceId: string, limit = 200): Promise<number> {
    if (!this.secrets) return 0;
    const target = this.directory.get(targetDeviceId) ?? (await this.lookupDevice(targetDeviceId));
    if (!target) throw new Error(t("error.not_found"));

    let shared = 0;
    for (const channel of this.state.channels) {
      const { messages } = await this.api.history(channel.id, undefined, limit);
      const rewrapped: Record<string, string> = {};
      for (const raw of messages) {
        if (raw.deleted || !raw.wrappedKey || !raw.header) continue;
        const sender = this.directory.get(raw.senderDevice);
        if (!sender) continue;
        try {
          const { cek } = await unwrapContentKey({
            channelId: channel.id,
            header: fromBase64(raw.header),
            body: fromBase64(raw.body),
            wrappedKey: fromBase64(raw.wrappedKey),
            senderDevice: sender,
            recipient: this.secrets,
          });
          const wrap = await rewrapFor(channel.suite || this.state.suiteId, channel.id, this.secrets, target, cek);
          rewrapped[raw.id] = toBase64(wrap);
        } catch {
          /* a message this device cannot read cannot be shared onward */
        }
      }
      if (Object.keys(rewrapped).length > 0) {
        await this.api.backfillKeys(targetDeviceId, rewrapped);
        shared += Object.keys(rewrapped).length;
      }
    }
    return shared;
  }

  private async lookupDevice(deviceId: string): Promise<DeviceRecord | null> {
    const { devices } = await this.api.listDevices();
    const found = devices.find((d) => d.id === deviceId);
    if (!found) return null;
    const record = toDeviceRecord(found);
    this.directory.set(deviceId, record);
    return record;
  }

  // ---------------------------------------------------------- verification

  safetyNumberWith(userId: string): string | null {
    if (!this.secrets) return null;
    const mine = new Uint8Array(64);
    mine.set(this.secrets.signingPublic, 0);
    mine.set(this.secrets.agreementPublic, 32);
    const theirs = [...this.directory.values()].find((d) => d.userId === userId);
    if (!theirs) return null;
    return safetyNumber(mine, this.state.user!.id, theirs.identityPub, userId);
  }

  /** Every device of a contact, with its own fingerprint. */
  devicesOf(userId: string): { deviceId: string; fingerprint: string; name: string }[] {
    return [...this.directory.values()]
      .filter((d) => d.userId === userId)
      .map((d) => ({
        deviceId: d.deviceId,
        fingerprint: deviceFingerprint(d.identityPub),
        name: d.deviceId.slice(0, 8),
      }));
  }

  trustStateOf(userId: string): TrustState {
    return this.state.trust[userId] ?? "unknown";
  }

  async markVerified(userId: string): Promise<void> {
    const theirs = [...this.directory.values()].find((d) => d.userId === userId);
    if (!theirs) return;
    this.trust.markVerified(userId, theirs.identityPub);
    this.set({ trust: { ...this.state.trust, [userId]: "verified" } });
    await this.persistVault();
  }

  async clearVerification(userId: string): Promise<void> {
    this.trust.clear(userId);
    this.set({ trust: { ...this.state.trust, [userId]: "unknown" } });
    await this.persistVault();
  }

  async acknowledgeKeyChange(userId: string): Promise<void> {
    this.trust.acknowledgeChange(userId);
    this.set({ trust: { ...this.state.trust, [userId]: "unknown" } });
    await this.persistVault();
  }

  fingerprintOf(device: DeviceJSON): string {
    return deviceFingerprint(fromBase64(device.identityPub));
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.api.revokeDevice(deviceId);
    await this.refreshDevices();
  }

  // ---------------------------------------------------------------- calls

  async startCall(channelId: string, video: boolean): Promise<void> {
    this.set({ incoming: null });
    this.clearRingExpiry();
    await this.calls.start(channelId, { video, ring: true });
  }

  async joinCall(channelId: string, video: boolean): Promise<void> {
    this.set({ incoming: null });
    this.clearRingExpiry();
    await this.calls.start(channelId, { video, ring: false });
  }

  async hangUp(): Promise<void> {
    await this.calls.hangUp();
  }

  /**
   * Say no to a ring.
   *
   * The push matters: dismissing the banner locally used to be the whole
   * implementation, which left the caller ringing at a room nobody was going
   * to join. Declining is an answer, so it has to travel.
   */
  declineCall(): void {
    const incoming = this.state.incoming;
    this.set({ incoming: null });
    this.clearRingExpiry();
    if (incoming) this.api.push({ type: "call.decline", channel: incoming.channelId });
  }

  /**
   * Drop the incoming banner if the caller vanished without saying anything —
   * a killed tab, a lost network. Slightly longer than the caller's own
   * give-up timer so that in the normal case the caller's `call.leave` clears
   * the banner first and this never fires.
   */
  private ringExpiry: ReturnType<typeof setTimeout> | null = null;

  private armRingExpiry(): void {
    this.clearRingExpiry();
    this.ringExpiry = setTimeout(() => {
      if (this.state.incoming) this.set({ incoming: null });
    }, 60_000);
  }

  private clearRingExpiry(): void {
    if (this.ringExpiry !== null) {
      clearTimeout(this.ringExpiry);
      this.ringExpiry = null;
    }
  }

  // ---------------------------------------------------------------- admin

  adminOverview(): Promise<AdminOverview> {
    return this.api.adminOverview();
  }

  adminUsers(): Promise<{ users: AdminUserRow[] }> {
    return this.api.adminUsers();
  }

  adminChannels(): Promise<{ channels: AdminChannelRow[] }> {
    return this.api.adminChannels();
  }

  adminSetFlags(id: string, flags: { isAdmin?: boolean; suspended?: boolean }): Promise<{ user: User }> {
    return this.api.adminSetFlags(id, flags);
  }

  adminCompact(): Promise<Record<string, unknown>> {
    return this.api.adminCompact();
  }

  // ------------------------------------------------------------ realtime

  private handleEvent = (ev: WsEvent): void => {
    switch (ev.type) {
      case "ready": {
        const data = (ev.data ?? {}) as { calls?: CallRoom[] };
        this.set({ activeRooms: data.calls ?? [] });
        break;
      }
      case "message.new":
        void this.onIncoming(ev);
        break;
      case "message.deleted": {
        const { id } = (ev.data ?? {}) as { id?: string };
        if (!id || !ev.channel) return;
        this.set({
          messages: {
            ...this.state.messages,
            [ev.channel]: (this.state.messages[ev.channel] ?? []).map((m) =>
              m.id === id ? { ...m, deleted: true, text: undefined, attachments: undefined } : m,
            ),
          },
        });
        void this.loadPinned(ev.channel);
        break;
      }
      case "message.pinned":
        if (ev.channel) {
          void this.loadPinned(ev.channel);
          void this.refreshChannels();
        }
        break;
      case "thread.created":
        if (ev.channel) void this.loadThreads(ev.channel);
        void this.refreshChannels();
        break;
      case "channel.cleared":
        if (!ev.channel) return;
        if (ev.channel === this.state.activeChannelId) {
          void this.openChannel(ev.channel);
        } else {
          // Drop the cached copy even when the chat is not on screen. Keeping
          // it meant a peer went on showing messages that no longer have keys
          // anywhere — they would render until the chat was reopened, and then
          // vanish, which looks like the app losing data rather than someone
          // exercising their own delete.
          const messages = { ...this.state.messages };
          delete messages[ev.channel];
          this.set({ messages });
        }
        void this.refreshChannels();
        break;
      case "channel.created":
      case "channel.updated":
      case "channel.members":
      case "channel.bump":
        void this.refreshChannels();
        break;
      case "session.revoked":
        void this.signOut();
        break;
      case "presence": {
        const { userId, online } = (ev.data ?? {}) as { userId?: string; online?: boolean };
        if (!userId) return;
        const set = new Set(this.state.online);
        if (online) set.add(userId);
        else set.delete(userId);
        this.set({ online: [...set] });
        break;
      }
      case "typing": {
        const { userId } = (ev.data ?? {}) as { userId?: string };
        if (!userId || !ev.channel) return;
        this.markTyping(ev.channel, userId);
        break;
      }
      case "call.ring": {
        const data = (ev.data ?? {}) as { from?: string; fromName?: string; video?: boolean };
        if (!ev.channel || !data.from) return;
        // Already in this call, or calling someone: no second ring.
        if (this.state.call?.channelId === ev.channel) return;
        this.set({
          incoming: {
            channelId: ev.channel,
            fromId: data.from,
            fromName: data.fromName ?? "",
            video: !!data.video,
            at: Date.now(),
          },
        });
        this.armRingExpiry();
        break;
      }
      case "call.decline": {
        if (!ev.channel) return;
        this.calls.onDeclined(ev.channel);
        break;
      }
      case "call.state": {
        const room = ev.data as CallRoom;
        this.calls.onRoom(room);
        const rooms = this.state.activeRooms.filter((r) => r.channelId !== room.channelId);
        if (room.participants.length > 0) rooms.push(room);
        this.set({ activeRooms: rooms });
        if (
          room.participants.length === 0 &&
          this.state.incoming?.channelId === room.channelId
        ) {
          this.set({ incoming: null });
          this.clearRingExpiry();
        }
        break;
      }
      case "call.signal": {
        const data = (ev.data ?? {}) as {
          from?: string;
          fromDevice?: string;
          payload?: unknown;
        };
        if (!data.from || !data.fromDevice) return;
        void this.calls.onSignal(data.from, data.fromDevice, data.payload as never);
        break;
      }
    }
  };

  private async onIncoming(ev: WsEvent): Promise<void> {
    const channelId = ev.channel;
    if (!channelId) return;
    const raw = ev.data as MessageJSON;
    if (raw.senderDevice === this.state.deviceId) return;

    const decrypted = await this.decrypt(channelId, raw);
    this.appendMessage(channelId, decrypted);

    if (this.state.activeChannelId === channelId) {
      void this.api.markRead(channelId, raw.seq);
    }
    void this.refreshChannels();
  }

  private markTyping(channelId: string, userId: string): void {
    const current = this.state.typing[channelId] ?? [];
    if (!current.includes(userId)) {
      this.set({ typing: { ...this.state.typing, [channelId]: [...current, userId] } });
    }
    const key = `${channelId}:${userId}`;
    const existing = this.typingTimers.get(key);
    if (existing) clearTimeout(existing);
    this.typingTimers.set(
      key,
      window.setTimeout(() => {
        this.typingTimers.delete(key);
        this.set({
          typing: {
            ...this.state.typing,
            [channelId]: (this.state.typing[channelId] ?? []).filter((id) => id !== userId),
          },
        });
      }, 4000),
    );
  }

  private appendMessage(channelId: string, message: DecryptedMessage): void {
    const list = this.state.messages[channelId] ?? [];
    if (list.some((m) => m.id === message.id)) return;
    this.set({ messages: { ...this.state.messages, [channelId]: [...list, message] } });
  }

  private replaceMessage(channelId: string, id: string, message: DecryptedMessage): void {
    this.set({
      messages: {
        ...this.state.messages,
        [channelId]: (this.state.messages[channelId] ?? []).map((m) => (m.id === id ? message : m)),
      },
    });
  }

  private patchMessage(channelId: string, id: string, patch: Partial<DecryptedMessage>): void {
    this.set({
      messages: {
        ...this.state.messages,
        [channelId]: (this.state.messages[channelId] ?? []).map((m) =>
          m.id === id ? { ...m, ...patch } : m,
        ),
      },
    });
  }

  dropPreKey(id: string): void {
    if (this.secrets) forgetPreKey(this.secrets, id);
  }
}

// ---------------------------------------------------------------- helpers

function isRootPath(pathname: string): boolean {
  return pathname === "/" || pathname === "" || pathname === "/index.html";
}

const ADMIN_TABS: AdminTab[] = ["overview", "users", "channels", "security", "pages"];

/** The whole router. Five routes do not need a library. */
function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (isRootPath(path)) return { kind: "app" };
  if (path === "/admin") return { kind: "admin", tab: "overview" };
  if (path.startsWith("/admin/")) {
    const tab = path.slice("/admin/".length) as AdminTab;
    return ADMIN_TABS.includes(tab) ? { kind: "admin", tab } : { kind: "notfound" };
  }
  // A deliberate look at the error page, so checking it does not require
  // inventing a broken link and then remembering it was deliberate.
  if (path === "/404" || path === "/404-preview") return { kind: "preview404" };
  return { kind: "notfound" };
}

/** The vault held only the secrets in v1; v2 keeps the trust store with them. */
function parseVault(stored: string): { secrets: DeviceSecrets; trust: TrustStore } {
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && "secrets" in parsed) {
      return {
        secrets: deserializeSecrets(parsed.secrets as string),
        trust: TrustStore.deserialize(parsed.trust as string),
      };
    }
  } catch {
    /* fall through to the v1 shape */
  }
  return { secrets: deserializeSecrets(stored), trust: new TrustStore() };
}

function attachmentKind(mime: string): AttachmentPayload["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

interface Measured {
  width?: number;
  height?: number;
  duration?: number;
  thumb?: string;
}

/**
 * Reads a picture's dimensions and makes a tiny inline preview, so the bubble
 * has the right shape and something to show before the full file is fetched.
 * The thumbnail is part of the encrypted payload, not a separate upload.
 */
async function measure(file: File): Promise<Measured> {
  if (file.type.startsWith("image/")) {
    try {
      const bitmap = await createImageBitmap(file);
      const thumb = downscale(bitmap, 24);
      const out: Measured = { width: bitmap.width, height: bitmap.height };
      if (thumb) out.thumb = thumb;
      bitmap.close();
      return out;
    } catch {
      return {};
    }
  }
  if (file.type.startsWith("video/")) {
    return new Promise<Measured>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      // Needed on Safari/iOS, where an unmuted or non-inline video will not
      // decode a frame off-screen and the poster silently stays blank.
      video.playsInline = true;
      const url = URL.createObjectURL(file);
      let settled = false;
      const done = (value: Measured) => {
        if (settled) return;
        settled = true;
        clearTimeout(bail);
        URL.revokeObjectURL(url);
        resolve(value);
      };
      // Grabbing a frame can hang on a codec the browser half-supports; the
      // dimensions alone are still worth having, so never wait forever.
      const bail = setTimeout(
        () =>
          done({
            width: video.videoWidth || undefined,
            height: video.videoHeight || undefined,
            duration: Math.round(video.duration) || undefined,
          }),
        4000,
      );

      const base = (): Measured => ({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Math.round(video.duration) || undefined,
      });

      // A video needs a poster for the same reason a photo needs a thumbnail:
      // the file is ciphertext until it is fully downloaded and decrypted, so
      // without one the bubble is a blank rectangle until then. Seek a little
      // way in — frame zero of a lot of video is black.
      video.onloadeddata = () => {
        try {
          video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
        } catch {
          done(base());
        }
      };
      video.onseeked = () => {
        const out = base();
        const canvas = document.createElement("canvas");
        const scale = 24 / Math.max(video.videoWidth || 1, video.videoHeight || 1);
        canvas.width = Math.max(1, Math.round((video.videoWidth || 1) * scale));
        canvas.height = Math.max(1, Math.round((video.videoHeight || 1) * scale));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            out.thumb = canvas.toDataURL("image/webp", 0.5);
          } catch {
            /* tainted or undecodable — dimensions are still useful */
          }
        }
        done(out);
      };
      video.onerror = () => done({});
      video.src = url;
    });
  }
  return {};
}

function downscale(bitmap: ImageBitmap, target: number): string | undefined {
  const scale = target / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.drawImage(bitmap, 0, 0, w, h);
  try {
    return canvas.toDataURL("image/webp", 0.5);
  } catch {
    return undefined;
  }
}

/**
 * Avatars are re-encoded to a 256px WebP before upload. That normalises the
 * format, strips whatever EXIF the camera left in (location, device model),
 * and keeps the stored file to a few kilobytes.
 */
async function prepareAvatar(file: File): Promise<{ mime: string; data: Uint8Array }> {
  const bitmap = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  // Cover-crop to a square so avatars never arrive stretched.
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.9),
  );
  if (!blob) throw new Error("could not encode the avatar");
  return { mime: "image/webp", data: new Uint8Array(await blob.arrayBuffer()) };
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function detectPlatform(): string {
  const ua = navigator.userAgent;
  if ((window as { __TAURI__?: unknown }).__TAURI__) {
    return /Windows/i.test(ua) ? "windows" : /Linux/i.test(ua) ? "linux" : "macos";
  }
  return "web";
}

function describeThisDevice(): string {
  const ua = navigator.userAgent;
  const tauri = !!(window as { __TAURI__?: unknown }).__TAURI__;
  const os = /Windows NT 10/.test(ua)
    ? "Windows"
    : /Linux/.test(ua)
      ? "Linux"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : "Unknown";
  if (tauri) return `Kivora Desktop · ${os}`;
  const browser = /Firefox\//.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} · ${os}`;
}
