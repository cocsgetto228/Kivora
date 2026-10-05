/**
 * ChaCha20-Poly1305 (RFC 8439) and XChaCha20-Poly1305 (the 24-byte-nonce
 * variant built on HChaCha20).
 *
 * XChaCha20 is the default AEAD in Kivora for one practical reason: its nonce is
 * large enough that generating it randomly for every message is safe. With a
 * 12-byte nonce, a client that forgets its counter after a reinstall can repeat
 * one, and nonce reuse in a stream cipher is catastrophic rather than
 * inconvenient. Buying that safety costs one extra block of keystream.
 */

import { concat, equalCT, readU32LE, writeU32LE } from "./bytes.ts";

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function quarterRound(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  x[a] = (x[a]! + x[b]!) >>> 0; x[d] = rotl(x[d]! ^ x[a]!, 16);
  x[c] = (x[c]! + x[d]!) >>> 0; x[b] = rotl(x[b]! ^ x[c]!, 12);
  x[a] = (x[a]! + x[b]!) >>> 0; x[d] = rotl(x[d]! ^ x[a]!, 8);
  x[c] = (x[c]! + x[d]!) >>> 0; x[b] = rotl(x[b]! ^ x[c]!, 7);
}

function chachaCore(state: Uint32Array, out: Uint32Array): void {
  out.set(state);
  for (let i = 0; i < 10; i++) {
    quarterRound(out, 0, 4, 8, 12);
    quarterRound(out, 1, 5, 9, 13);
    quarterRound(out, 2, 6, 10, 14);
    quarterRound(out, 3, 7, 11, 15);
    quarterRound(out, 0, 5, 10, 15);
    quarterRound(out, 1, 6, 11, 12);
    quarterRound(out, 2, 7, 8, 13);
    quarterRound(out, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) out[i] = (out[i]! + state[i]!) >>> 0;
}

function buildState(key: Uint8Array, nonce12: Uint8Array, counter: number): Uint32Array {
  const s = new Uint32Array(16);
  s.set(SIGMA, 0);
  for (let i = 0; i < 8; i++) s[4 + i] = readU32LE(key, i * 4);
  s[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) s[13 + i] = readU32LE(nonce12, i * 4);
  return s;
}

/** ChaCha20 keystream XORed into `data`, starting at block `counter`. */
export function chacha20(key: Uint8Array, nonce12: Uint8Array, data: Uint8Array, counter: number = 0): Uint8Array {
  const state = buildState(key, nonce12, counter);
  const block = new Uint32Array(16);
  const keystream = new Uint8Array(64);
  const out = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at += 64) {
    chachaCore(state, block);
    for (let i = 0; i < 16; i++) writeU32LE(keystream, i * 4, block[i]!);
    const n = Math.min(64, data.length - at);
    for (let i = 0; i < n; i++) out[at + i] = data[at + i]! ^ keystream[i]!;
    state[12] = (state[12]! + 1) >>> 0;
  }
  return out;
}

/** HChaCha20: derives a subkey from a key and 16 nonce bytes. */
export function hchacha20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  const s = new Uint32Array(16);
  s.set(SIGMA, 0);
  for (let i = 0; i < 8; i++) s[4 + i] = readU32LE(key, i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = readU32LE(nonce16, i * 4);
  const x = new Uint32Array(s);
  for (let i = 0; i < 10; i++) {
    quarterRound(x, 0, 4, 8, 12);
    quarterRound(x, 1, 5, 9, 13);
    quarterRound(x, 2, 6, 10, 14);
    quarterRound(x, 3, 7, 11, 15);
    quarterRound(x, 0, 5, 10, 15);
    quarterRound(x, 1, 6, 11, 12);
    quarterRound(x, 2, 7, 8, 13);
    quarterRound(x, 3, 4, 9, 14);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) writeU32LE(out, i * 4, x[i]!);
  for (let i = 0; i < 4; i++) writeU32LE(out, 16 + i * 4, x[12 + i]!);
  return out;
}

// ---------------------------------------------------------------- Poly1305

const POLY_P = (1n << 130n) - 5n;
const CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn;
const MASK128 = (1n << 128n) - 1n;

function leToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

/**
 * Poly1305 one-time authenticator (RFC 8439 §2.5).
 *
 * The arithmetic is done with BigInt rather than hand-packed 26-bit limbs.
 * Limb-packed versions are faster, but they are also where this kind of code
 * usually goes subtly wrong, and a wrong MAC is a silent security failure
 * rather than a visible bug. Chat messages are small; the difference does not
 * show up in a chat window.
 */
export function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  const r = leToBigInt(key.subarray(0, 16)) & CLAMP;
  const s = leToBigInt(key.subarray(16, 32));
  let acc = 0n;

  for (let at = 0; at < message.length; at += 16) {
    const chunk = message.subarray(at, Math.min(at + 16, message.length));
    // Each block is read little-endian with an extra 1 bit above its top byte.
    const n = leToBigInt(chunk) + (1n << BigInt(8 * chunk.length));
    acc = ((acc + n) * r) % POLY_P;
  }

  const tagValue = (acc + s) & MASK128;
  const out = new Uint8Array(16);
  let v = tagValue;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function pad16(n: number): Uint8Array {
  const rem = n % 16;
  return rem === 0 ? new Uint8Array(0) : new Uint8Array(16 - rem);
}

function lengthsBlock(adLen: number, ctLen: number): Uint8Array {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, adLen >>> 0, true);
  dv.setUint32(4, Math.floor(adLen / 0x100000000), true);
  dv.setUint32(8, ctLen >>> 0, true);
  dv.setUint32(12, Math.floor(ctLen / 0x100000000), true);
  return b;
}

function tagFor(key: Uint8Array, nonce12: Uint8Array, ad: Uint8Array, ct: Uint8Array): Uint8Array {
  // The one-time Poly1305 key is the first 32 bytes of the ChaCha20 keystream
  // at counter 0; the message itself starts at counter 1.
  const polyKey = chacha20(key, nonce12, new Uint8Array(32), 0);
  const input = concat(
    ad, pad16(ad.length),
    ct, pad16(ct.length),
    lengthsBlock(ad.length, ct.length),
  );
  return poly1305(polyKey, input);
}

export const NONCE_LEN = 12;
export const XNONCE_LEN = 24;
export const KEY_LEN = 32;
export const TAG_LEN = 16;

/** ChaCha20-Poly1305 AEAD. Returns ciphertext||tag. */
export function seal(key: Uint8Array, nonce12: Uint8Array, plaintext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (key.length !== KEY_LEN) throw new Error("chacha20poly1305: key must be 32 bytes");
  if (nonce12.length !== NONCE_LEN) throw new Error("chacha20poly1305: nonce must be 12 bytes");
  const ct = chacha20(key, nonce12, plaintext, 1);
  const tag = tagFor(key, nonce12, ad, ct);
  const out = new Uint8Array(ct.length + TAG_LEN);
  out.set(ct);
  out.set(tag, ct.length);
  return out;
}

export function open(key: Uint8Array, nonce12: Uint8Array, sealed: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (sealed.length < TAG_LEN) throw new Error("chacha20poly1305: ciphertext too short");
  const ct = sealed.subarray(0, sealed.length - TAG_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  if (!equalCT(tagFor(key, nonce12, ad, ct), tag)) {
    throw new Error("chacha20poly1305: authentication failed");
  }
  return chacha20(key, nonce12, ct, 1);
}

/** XChaCha20-Poly1305: HChaCha20 turns the first 16 nonce bytes into a subkey. */
export function xseal(key: Uint8Array, nonce24: Uint8Array, plaintext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (nonce24.length !== XNONCE_LEN) throw new Error("xchacha20poly1305: nonce must be 24 bytes");
  const subKey = hchacha20(key, nonce24.subarray(0, 16));
  const n12 = new Uint8Array(12);
  n12.set(nonce24.subarray(16), 4);
  return seal(subKey, n12, plaintext, ad);
}

export function xopen(key: Uint8Array, nonce24: Uint8Array, sealed: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (nonce24.length !== XNONCE_LEN) throw new Error("xchacha20poly1305: nonce must be 24 bytes");
  const subKey = hchacha20(key, nonce24.subarray(0, 16));
  const n12 = new Uint8Array(12);
  n12.set(nonce24.subarray(16), 4);
  return open(subKey, n12, sealed, ad);
}
