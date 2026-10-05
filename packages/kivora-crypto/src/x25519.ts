/**
 * X25519 key agreement (RFC 7748).
 *
 * Two implementations live behind one function:
 *
 *  - WebCrypto, when the runtime exposes the X25519 algorithm. That path runs
 *    in constant time in native code and is what you get in Chromium-based
 *    WebViews, so it is what the Windows desktop build and modern browsers use.
 *  - A BigInt Montgomery ladder, as a fallback for runtimes without it.
 *
 * The fallback is honest about its limits: JavaScript BigInt arithmetic is not
 * constant-time, so on a machine where an attacker can run code alongside the
 * client and measure precisely, it is theoretically susceptible to timing
 * analysis. It is here so the messenger works everywhere, and `x25519Backend()`
 * lets the UI tell the user which one is in use.
 */

const P = (1n << 255n) - 19n;
const A24 = 121665n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function invert(a: bigint): bigint {
  // Fermat: a^(p-2) mod p. Square-and-multiply over a fixed exponent.
  let result = 1n;
  let base = mod(a);
  let e = P - 2n;
  while (e > 0n) {
    if (e & 1n) result = mod(result * base);
    base = mod(base * base);
    e >>= 1n;
  }
  return result;
}

function decodeScalar(k: Uint8Array): bigint {
  const c = Uint8Array.from(k);
  // Clamping (RFC 7748 §5): clear the low 3 bits, clear bit 255, set bit 254.
  c[0]! ; c[0] = c[0]! & 248;
  c[31] = (c[31]! & 127) | 64;
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(c[i]!);
  return n;
}

function decodeU(u: Uint8Array): bigint {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(i === 31 ? u[i]! & 127 : u[i]!);
  return mod(n);
}

function encodeU(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = mod(n);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The scalar multiplication itself: the Montgomery ladder from RFC 7748. */
export function scalarMult(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  const k = decodeScalar(scalar);
  const x1 = decodeU(u);
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t--) {
    const kt = (k >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;

    const a = mod(x2 + z2);
    const aa = mod(a * a);
    const b = mod(x2 - z2);
    const bb = mod(b * b);
    const e = mod(aa - bb);
    const c = mod(x3 + z3);
    const d = mod(x3 - z3);
    const da = mod(d * a);
    const cb = mod(c * b);
    x3 = mod((da + cb) * (da + cb));
    z3 = mod(x1 * mod((da - cb) * (da - cb)));
    x2 = mod(aa * bb);
    z2 = mod(e * mod(aa + mod(A24 * e)));
  }
  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  return encodeU(mod(x2 * invert(z2)));
}

const BASE_POINT = new Uint8Array(32);
BASE_POINT[0] = 9;

export function scalarMultBase(scalar: Uint8Array): Uint8Array {
  return scalarMult(scalar, BASE_POINT);
}

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

let webcryptoX25519: boolean | null = null;

async function probeWebCrypto(): Promise<boolean> {
  if (webcryptoX25519 !== null) return webcryptoX25519;
  try {
    const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    webcryptoX25519 = !!kp.privateKey;
  } catch {
    webcryptoX25519 = false;
  }
  return webcryptoX25519;
}

/** Which implementation will be used. Surfaced in the UI's security panel. */
export async function x25519Backend(): Promise<"webcrypto" | "bigint"> {
  return (await probeWebCrypto()) ? "webcrypto" : "bigint";
}

export async function generateKeyPair(): Promise<KeyPair> {
  if (await probeWebCrypto()) {
    const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const priv = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const pub = await crypto.subtle.exportKey("raw", kp.publicKey);
    // The raw 32-byte scalar is the tail of the PKCS#8 blob.
    return {
      privateKey: new Uint8Array(priv).slice(-32),
      publicKey: new Uint8Array(pub),
    };
  }
  const privateKey = new Uint8Array(32);
  crypto.getRandomValues(privateKey);
  privateKey[0] = privateKey[0]! & 248;
  privateKey[31] = (privateKey[31]! & 127) | 64;
  return { privateKey, publicKey: scalarMultBase(privateKey) };
}

const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
  0x04, 0x22, 0x04, 0x20,
]);

export async function agree(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
  if (await probeWebCrypto()) {
    try {
      const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
      pkcs8.set(PKCS8_PREFIX);
      pkcs8.set(privateKey, PKCS8_PREFIX.length);
      const priv = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "X25519" }, false, [
        "deriveBits",
      ]);
      const pub = await crypto.subtle.importKey("raw", publicKey as BufferSource, { name: "X25519" }, false, []);
      const bits = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256);
      return new Uint8Array(bits);
    } catch {
      // Fall through to the portable path rather than failing the message.
    }
  }
  const shared = scalarMult(privateKey, publicKey);
  // RFC 7748 §6.1: an all-zero shared secret means a small-order public key
  // was supplied. Continuing would encrypt to a key the attacker knows.
  let acc = 0;
  for (const b of shared) acc |= b;
  if (acc === 0) throw new Error("x25519: peer supplied a small-order public key");
  return shared;
}
