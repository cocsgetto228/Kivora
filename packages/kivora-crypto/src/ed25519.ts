/**
 * Ed25519 signatures (RFC 8032).
 *
 * Kivora uses signatures for exactly one thing, and it is an important one:
 * a device signs its own pre-keys, so a malicious or compromised server cannot
 * swap in a pre-key it controls and read the next conversation that starts.
 * Without that signature the server is trusted, and the whole point of the
 * design is that it is not.
 *
 * As with X25519, the native implementation is preferred when the runtime
 * offers one; the BigInt fallback keeps the client working everywhere else.
 * SHA-512 comes from WebCrypto, which is why these functions are async.
 */

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
const Bx = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const By = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

function mod(a: bigint, m = P): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

const invert = (a: bigint) => pow(a, P - 2n);

interface Point {
  x: bigint;
  y: bigint;
  z: bigint;
  t: bigint;
}

const ZERO: Point = { x: 0n, y: 1n, z: 1n, t: 0n };
const BASE: Point = { x: Bx, y: By, z: 1n, t: mod(Bx * By) };

/** Addition on the twisted Edwards curve in extended coordinates (a = -1). */
function add(p: Point, q: Point): Point {
  const a = mod((p.y - p.x) * (q.y - q.x));
  const b = mod((p.y + p.x) * (q.y + q.x));
  const c = mod(p.t * 2n * D * q.t);
  const dd = mod(p.z * 2n * q.z);
  const e = b - a;
  const f = dd - c;
  const g = dd + c;
  const h = b + a;
  return { x: mod(e * f), y: mod(g * h), t: mod(e * h), z: mod(f * g) };
}

function scalarMul(p: Point, n: bigint): Point {
  let result = ZERO;
  let base = p;
  let k = mod(n, L);
  while (k > 0n) {
    if (k & 1n) result = add(result, base);
    base = add(base, base);
    k >>= 1n;
  }
  return result;
}

function equals(p: Point, q: Point): boolean {
  return mod(p.x * q.z) === mod(q.x * p.z) && mod(p.y * q.z) === mod(q.y * p.z);
}

function encodePoint(p: Point): Uint8Array {
  const zInv = invert(p.z);
  const x = mod(p.x * zInv);
  const y = mod(p.y * zInv);
  const out = new Uint8Array(32);
  let v = y;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out[31] = out[31]! | (Number(x & 1n) << 7);
  return out;
}

function decodePoint(bytes: Uint8Array): Point | null {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  if (y >= P) return null;
  const sign = BigInt((bytes[31]! >> 7) & 1);

  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  let x = mod(u * invert(v));
  x = pow(x, (P + 3n) / 8n);
  if (mod(x * x) !== mod(u * invert(v))) x = mod(x * SQRT_M1);
  if (mod(x * x) !== mod(u * invert(v))) return null;
  if ((x & 1n) !== sign) x = mod(-x);
  return { x, y, z: 1n, t: mod(x * y) };
}

function leToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

function bigIntToLe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

async function sha512(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-512", data as BufferSource));
}

function clampScalar(h: Uint8Array): bigint {
  const a = h.slice(0, 32);
  a[0] = a[0]! & 248;
  a[31] = (a[31]! & 127) | 64;
  return leToBigInt(a);
}

export interface SigningKeyPair {
  /** 32-byte seed. This is the value that must never leave the device. */
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

let nativeEd: boolean | null = null;

async function probeNative(): Promise<boolean> {
  if (nativeEd !== null) return nativeEd;
  try {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    nativeEd = !!kp.privateKey;
  } catch {
    nativeEd = false;
  }
  return nativeEd;
}

export async function ed25519Backend(): Promise<"webcrypto" | "bigint"> {
  return (await probeNative()) ? "webcrypto" : "bigint";
}

export async function publicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  const h = await sha512(seed);
  return encodePoint(scalarMul(BASE, clampScalar(h)));
}

export async function generateKeyPair(): Promise<SigningKeyPair> {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return { privateKey: seed, publicKey: await publicKeyFromSeed(seed) };
}

export async function sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const h = await sha512(seed);
  const a = clampScalar(h);
  const prefix = h.slice(32, 64);
  const publicKey = encodePoint(scalarMul(BASE, a));

  const rBytes = await sha512(concatBytes(prefix, message));
  const r = mod(leToBigInt(rBytes), L);
  const R = encodePoint(scalarMul(BASE, r));

  const kBytes = await sha512(concatBytes(R, publicKey, message));
  const k = mod(leToBigInt(kBytes), L);
  const s = mod(r + k * a, L);

  return concatBytes(R, bigIntToLe32(s));
}

export async function verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  const R = decodePoint(signature.subarray(0, 32));
  const A = decodePoint(publicKey);
  if (!R || !A) return false;

  const s = leToBigInt(signature.subarray(32, 64));
  // A signature with s >= L is malleable: reject it rather than accept a
  // second valid encoding of the same signature.
  if (s >= L) return false;

  const kBytes = await sha512(concatBytes(signature.subarray(0, 32), publicKey, message));
  const k = mod(leToBigInt(kBytes), L);

  const lhs = scalarMul(BASE, s);
  const rhs = add(R, scalarMul(A, k));
  return equals(lhs, rhs);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
