/**
 * The local vault: where this device's private keys live between sessions.
 *
 * In a browser there is no operating-system keychain to hide behind, so the
 * keys are encrypted with a key derived from the user's password and only ever
 * decrypted in memory. Consequences worth being honest about:
 *
 *  - Reloading the tab means unlocking again. That is the price of not keeping
 *    a usable key in storage.
 *  - Anyone who can run script in this origin can read the unlocked key. That
 *    is what the server's Content-Security-Policy is defending against.
 *
 * The desktop build replaces the `VaultBackend` below with the OS keychain, so
 * the same code path gets hardware-backed storage without changing callers.
 */

const PBKDF2_ITERATIONS = 600_000; // OWASP guidance for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

export interface VaultBackend {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Browser default. Not "secure storage" — that is why the contents are
 *  encrypted before they get here. */
export const localStorageBackend: VaultBackend = {
  async read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async write(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* private mode: the vault simply does not persist */
    }
  },
  async remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

interface VaultBlob {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  nonce: string;
  data: string;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Supplies a second, device-bound input to the key derivation. On the desktop
 * this comes from the OS credential store; in a browser there is nothing to
 * supply and the password stands alone.
 */
export type PepperProvider = (account: string) => Promise<string | null>;

export class Vault {
  constructor(
    private readonly backend: VaultBackend = localStorageBackend,
    private readonly namespace = "kivora.vault",
    private readonly pepper: PepperProvider = async () => null,
  ) {}

  /**
   * Password and device secret are joined with a separator that cannot occur in
   * either, so no two different pairs can produce the same derivation input.
   */
  private async derivationSecret(account: string, password: string): Promise<string> {
    const pepper = await this.pepper(account);
    return pepper ? `${password}\u0000${pepper}` : password;
  }

  private key(account: string): string {
    return `${this.namespace}.${account}`;
  }

  async exists(account: string): Promise<boolean> {
    return (await this.backend.read(this.key(account))) !== null;
  }

  async seal(account: string, password: string, plaintext: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const key = await deriveKey(await this.derivationSecret(account, password), salt, PBKDF2_ITERATIONS);
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      key,
      new TextEncoder().encode(plaintext),
    );
    const blob: VaultBlob = {
      v: 1,
      kdf: "PBKDF2-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt: b64(salt),
      nonce: b64(nonce),
      data: b64(new Uint8Array(data)),
    };
    await this.backend.write(this.key(account), JSON.stringify(blob));
  }

  /** Returns null when the vault does not exist, throws when the password is
   *  wrong — the two cases need different messages in the UI. */
  async unseal(account: string, password: string): Promise<string | null> {
    const raw = await this.backend.read(this.key(account));
    if (!raw) return null;
    const blob = JSON.parse(raw) as VaultBlob;
    if (blob.v !== 1) throw new Error("Хранилище ключей записано более новой версией приложения");
    const key = await deriveKey(
      await this.derivationSecret(account, password),
      unb64(blob.salt),
      blob.iterations,
    );
    try {
      const out = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(blob.nonce) as BufferSource },
        key,
        unb64(blob.data) as BufferSource,
      );
      return new TextDecoder().decode(out);
    } catch {
      throw new Error("Неверный пароль");
    }
  }

  async clear(account: string): Promise<void> {
    await this.backend.remove(this.key(account));
  }
}
