/**
 * The pluggable cipher-suite interface.
 *
 * This is the extension point the whole project is built around: everything
 * above it — the envelope format, the client, the server's policy checks — is
 * written against `CipherSuite` and never against a particular algorithm.
 * Adding your own cryptography means implementing this interface, registering
 * it, and adding its id to the server's allow-list. No fork, no rebuild of
 * anything else. See docs/CRYPTO.md for a worked example.
 *
 * The naming rule for ids is `vendor.primitives.vN`. The version is not
 * decoration: two devices only talk when family *and* version match, which is
 * what stops an attacker from negotiating a peer down to your old suite.
 */

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** A device's long-term key material. */
export interface Identity {
  /** Signing key. Its public half is the device's stable fingerprint. */
  signing: KeyPair;
  /** Key-agreement key, used to authenticate the sender of every message. */
  agreement: KeyPair;
}

export interface SuiteCapabilities {
  /** Bytes in a symmetric key. */
  keyLength: number;
  /** Bytes in an AEAD nonce. 24 means random nonces are safe. */
  nonceLength: number;
  /** Bytes added by the AEAD tag. */
  overhead: number;
  /** Whether pre-keys can be signed — false disables that hardening. */
  signatures: boolean;
  /** Human-readable note shown in the client's security panel. */
  notes?: string;
}

export interface CipherSuite extends SuiteCapabilities {
  readonly id: string;
  readonly label: string;

  /** Fresh long-term identity for a new device. */
  generateIdentity(): Promise<Identity>;
  /** Fresh ephemeral / pre-key agreement pair. */
  generateKeyPair(): Promise<KeyPair>;

  /** Diffie-Hellman. Must throw on degenerate peer keys. */
  agree(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array>;
  /** Key derivation. Must be domain-separated by `info`. */
  kdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array>;

  /** Authenticated encryption. `aad` is authenticated but not encrypted. */
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  /** Must throw — never return a value — when authentication fails. */
  open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;

  sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;

  randomBytes(length: number): Uint8Array;
  /** Which implementation is actually running: native or portable. */
  backend?(): Promise<string>;
}

const registry = new Map<string, CipherSuite>();
let preferred: string | null = null;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:[-+][a-z0-9]+)*\.v[0-9]+$/;

export function registerSuite(suite: CipherSuite, { preferredSuite = false } = {}): void {
  if (!ID_PATTERN.test(suite.id)) {
    throw new Error(
      `suite id "${suite.id}" must look like vendor.primitives.vN, e.g. acme.x25519-aes256gcm.v1`,
    );
  }
  if (suite.nonceLength < 12 || suite.keyLength < 16) {
    throw new Error(`suite "${suite.id}" declares parameters below the minimum (16-byte key, 12-byte nonce)`);
  }
  registry.set(suite.id, suite);
  if (preferredSuite || preferred === null) preferred = suite.id;
}

export function getSuite(id: string): CipherSuite {
  const s = registry.get(id);
  if (!s) throw new Error(`unknown cipher suite "${id}" — is its module imported and registered?`);
  return s;
}

export function hasSuite(id: string): boolean {
  return registry.has(id);
}

export function listSuites(): CipherSuite[] {
  return [...registry.values()];
}

export function defaultSuiteId(): string {
  if (!preferred) throw new Error("no cipher suite registered");
  return preferred;
}

export function setDefaultSuite(id: string): void {
  if (!registry.has(id)) throw new Error(`cannot default to unregistered suite "${id}"`);
  preferred = id;
}

export function suiteFamily(id: string): string {
  const i = id.lastIndexOf(".v");
  return i > 0 ? id.slice(0, i) : id;
}

export function suiteVersion(id: string): number {
  const i = id.lastIndexOf(".v");
  return i > 0 ? Number.parseInt(id.slice(i + 2), 10) || 0 : 0;
}

/**
 * Two devices can talk when they agree on family and version. Accepting a
 * lower version "to be compatible" is exactly the downgrade attack that has
 * broken every protocol that allowed it.
 */
export function suitesCompatible(a: string, b: string): boolean {
  return suiteFamily(a) === suiteFamily(b) && suiteVersion(a) === suiteVersion(b);
}

/**
 * Pick the best suite both sides support: highest version within a family both
 * know, never falling below what we ourselves consider the default's family.
 */
export function negotiate(mine: string[], theirs: string[]): string | null {
  const theirSet = new Set(theirs);
  const shared = mine.filter((id) => theirSet.has(id));
  if (shared.length === 0) return null;
  return shared.sort((a, b) => suiteVersion(b) - suiteVersion(a))[0]!;
}
