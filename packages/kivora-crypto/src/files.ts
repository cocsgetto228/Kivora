/**
 * File encryption.
 *
 * A photo or a video gets its own one-time key, and that key travels **inside
 * the message plaintext**. The consequence is worth stating plainly: an
 * attachment inherits every protection the message already has — it is wrapped
 * per recipient device, authenticated as coming from the sender, and bound to
 * its channel — without a second key hierarchy to get wrong.
 *
 * The bytes on the server are therefore ciphertext with no key anywhere near
 * them. Deleting the message deletes the wrapped content key, which is what
 * makes the file unreadable even to someone holding an old copy of the store.
 */

import { fromBase64, toBase64, utf8, wipe } from "./bytes.ts";
import { getSuite } from "./suite.ts";

export const FILE_FORMAT_VERSION = 1;

/** What the sender puts in the message so recipients can open the file. */
export interface FileKey {
  v: number;
  suite: string;
  /** The one-time file key, base64. */
  k: string;
  /** The AEAD nonce, base64. */
  n: string;
}

export interface SealedFile {
  ciphertext: Uint8Array;
  key: FileKey;
}

function fileAad(channelId: string): Uint8Array {
  return utf8(`kivora-file/v${FILE_FORMAT_VERSION}|${channelId}`);
}

/**
 * Encrypt a file for one channel. The returned key must be sent inside the
 * message body — never as a separate field the server could store next to the
 * ciphertext, which would defeat the whole exercise.
 */
export async function sealFile(
  suiteId: string,
  channelId: string,
  data: Uint8Array,
): Promise<SealedFile> {
  const suite = getSuite(suiteId);
  const key = suite.randomBytes(suite.keyLength);
  const nonce = suite.randomBytes(suite.nonceLength);
  const ciphertext = await suite.seal(key, nonce, data, fileAad(channelId));
  const record: FileKey = {
    v: FILE_FORMAT_VERSION,
    suite: suiteId,
    k: toBase64(key),
    n: toBase64(nonce),
  };
  wipe(key);
  return { ciphertext, key: record };
}

export async function openFile(
  key: FileKey,
  channelId: string,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (key.v !== FILE_FORMAT_VERSION) {
    throw new Error(`unsupported file format version ${key.v}`);
  }
  const suite = getSuite(key.suite);
  const raw = fromBase64(key.k);
  try {
    return await suite.open(raw, fromBase64(key.n), ciphertext, fileAad(channelId));
  } finally {
    wipe(raw);
  }
}

/**
 * Rough size of the ciphertext, so the UI can check a file against the server's
 * limit before spending time encrypting it.
 */
export function sealedSize(suiteId: string, plainSize: number): number {
  return plainSize + getSuite(suiteId).overhead;
}
