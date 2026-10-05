/**
 * The default suite: X25519 for key agreement, HKDF-SHA256 for derivation,
 * XChaCha20-Poly1305 for authenticated encryption, Ed25519 for pre-key
 * signatures.
 *
 * Chosen over an AES-based suite as the default because ChaCha is fast in
 * software on machines without AES hardware — which is most of the cheap
 * hardware a self-hosted messenger actually runs on — and because a 24-byte
 * nonce can be generated randomly per message without a counter to lose.
 */

import type { CipherSuite, Identity, KeyPair } from "../suite.ts";
import { randomBytes } from "../bytes.ts";
import { hkdf } from "../sha256.ts";
import * as x from "../x25519.ts";
import * as ed from "../ed25519.ts";
import { xseal, xopen, KEY_LEN, XNONCE_LEN, TAG_LEN } from "../chacha20poly1305.ts";

export const XChaCha20Suite: CipherSuite = {
  id: "kivora.x25519-xchacha20poly1305.v1",
  label: "X25519 · XChaCha20-Poly1305 · Ed25519",
  keyLength: KEY_LEN,
  nonceLength: XNONCE_LEN,
  overhead: TAG_LEN,
  signatures: true,
  notes: "Default suite. Software-fast, random nonces are safe at this size.",

  async generateIdentity(): Promise<Identity> {
    const signing = await ed.generateKeyPair();
    const agreement = await x.generateKeyPair();
    return { signing, agreement };
  },

  generateKeyPair(): Promise<KeyPair> {
    return x.generateKeyPair();
  },

  agree(privateKey, publicKey) {
    return x.agree(privateKey, publicKey);
  },

  async kdf(ikm, salt, info, length) {
    return hkdf(ikm, salt, info, length);
  },

  async seal(key, nonce, plaintext, aad) {
    return xseal(key, nonce, plaintext, aad);
  },

  async open(key, nonce, ciphertext, aad) {
    return xopen(key, nonce, ciphertext, aad);
  },

  sign(privateKey, message) {
    return ed.sign(privateKey, message);
  },

  verify(publicKey, message, signature) {
    return ed.verify(publicKey, message, signature);
  },

  randomBytes,

  async backend() {
    return `x25519:${await x.x25519Backend()} ed25519:${await ed.ed25519Backend()}`;
  },
};
