/**
 * The bridge to the desktop core.
 *
 * In a browser every function here returns null or a no-op, and the client
 * behaves exactly as the web version does. Inside the Tauri shell the same
 * calls reach the Rust core, which adds what a browser cannot: a device secret
 * held by the operating system's credential store, and unlock throttling that
 * clearing site data does not reset.
 *
 * The Tauri API is reached through the injected global rather than an npm
 * package, so the web build carries no desktop-only dependency at all.
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriGlobal {
  core?: { invoke: Invoke };
  invoke?: Invoke;
}

export interface CoreInfo {
  version: string;
  keychain: boolean;
  secretStorage: "os-keychain" | "app-data-file";
  platform: string;
}

function bridge(): Invoke | null {
  const g = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!g) return null;
  return g.core?.invoke ?? g.invoke ?? null;
}

export const isDesktop = (): boolean => bridge() !== null;

export async function coreInfo(account: string): Promise<CoreInfo | null> {
  const invoke = bridge();
  if (!invoke) return null;
  const raw = (await invoke("core_info", { account })) as {
    version: string;
    keychain: boolean;
    secret_storage: CoreInfo["secretStorage"];
    platform: string;
  };
  return {
    version: raw.version,
    keychain: raw.keychain,
    secretStorage: raw.secret_storage,
    platform: raw.platform,
  };
}

/**
 * The device half of the vault key. Combined with the user's password, it means
 * a copied profile directory is not enough to attack the vault offline: the
 * attacker also needs the credential-store entry, which is tied to the user's
 * login session on that machine.
 */
export async function deviceSecret(account: string): Promise<string | null> {
  const invoke = bridge();
  if (!invoke) return null;
  try {
    return (await invoke("device_secret", { account })) as string;
  } catch {
    return null;
  }
}

export async function unlockDelay(account: string): Promise<number> {
  const invoke = bridge();
  if (!invoke) return 0;
  try {
    return (await invoke("unlock_delay", { account })) as number;
  } catch {
    return 0;
  }
}

export async function noteUnlockFailure(account: string): Promise<number> {
  const invoke = bridge();
  if (!invoke) return 0;
  try {
    return (await invoke("note_unlock_failure", { account })) as number;
  } catch {
    return 0;
  }
}

export async function noteUnlockSuccess(account: string): Promise<void> {
  const invoke = bridge();
  if (!invoke) return;
  try {
    await invoke("note_unlock_success", { account });
  } catch {
    /* throttling is a hardening measure, never a reason to block a valid login */
  }
}

export async function forgetDevice(account: string): Promise<void> {
  const invoke = bridge();
  if (!invoke) return;
  try {
    await invoke("forget_device", { account });
  } catch {
    /* the local vault is cleared regardless */
  }
}
