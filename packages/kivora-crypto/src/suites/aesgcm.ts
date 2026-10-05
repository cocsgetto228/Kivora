/**
 * A second, fully working suite: same key agreement, AES-256-GCM instead of
 * XChaCha20-Poly1305, using the platform's WebCrypto implementation.
 *
 * It is here for two reasons. It is genuinely useful — on a modern CPU the
 * hardware AES path beats ChaCha, and some compliance regimes want AES
 * specifically. And it is the worked example for the extension point: this file
 * is what "add your own encryption" looks like end to end. Note that the nonce
 * is 12 bytes here, so it is derived per message rather than chosen randomly
 * without care; the envelope layer handles that through `nonceLength`.
 */

import type { CipherSuite, Identity, KeyPair } from "../suite.ts";
import { randomBytes } from "../bytes.ts";
import { hkdf } from "../sha256.ts";
import * as x from "../x25519.ts";
import * as ed from "../ed25519.ts";

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export const AesGcmSuite: CipherSuite = {
  id: "kivora.x25519-aes256gcm.v1",
  label: "X25519 · AES-256-GCM · Ed25519",
  keyLength: 32,
  nonceLength: 12,
  overhead: 16,
  signatures: true,
  notes: "Uses the platform's hardware-accelerated AES. 12-byte nonces are derived, never reused.",

  async generateIdentity(): Promise<Identity> {
    return { signing: await ed.generateKeyPair(), agreement: await x.generateKeyPair() };
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
    const k = await importKey(key);
    const out = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
      k,
      plaintext as BufferSource,
    );
    return new Uint8Array(out);
  },

  async open(key, nonce, ciphertext, aad) {
    const k = await importKey(key);
    try {
      const out = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
        k,
        ciphertext as BufferSource,
      );
      return new Uint8Array(out);
    } catch {
      // WebCrypto throws an OperationError with no detail; make it explicit.
      throw new Error("aes-256-gcm: authentication failed");
    }
  },

  sign(privateKey, message) {
    return ed.sign(privateKey, message);
  },

  verify(publicKey, message, signature) {
    return ed.verify(publicKey, message, signature);
  },

  randomBytes,

  async backend() {
    return `aes:webcrypto x25519:${await x.x25519Backend()}`;
  },
};
