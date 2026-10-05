/**
 * The message envelope: how a plaintext becomes something the server can store
 * but not read.
 *
 * The shape is multi-recipient ECIES, the same idea behind PGP's session keys
 * and Signal's sender keys:
 *
 *   1. Draw a fresh content key (CEK) for this one message.
 *   2. Encrypt the message body once, under the CEK.
 *   3. For every recipient *device*, wrap the CEK to a key derived from a
 *      Diffie-Hellman with that device's pre-key.
 *
 * The server stores the body and the wrapped keys and can correlate neither.
 * Encrypting once and wrapping N times is also why a 40-person channel does not
 * cost 40 encryptions of the message itself.
 *
 * Two Diffie-Hellmans go into every wrap, not one:
 *
 *   DH(ephemeral, recipientPreKey)   gives forward secrecy — the ephemeral
 *                                    private key is discarded immediately
 *   DH(senderIdentity, recipientPreKey)  gives sender authentication — only
 *                                    the real sender could have produced it
 *
 * Dropping either one breaks something real: without the first, stealing a
 * device's long-term key decrypts its whole history; without the second,
 * anyone can forge a message from anyone.
 */

import { concat, fromBase64, toBase64, utf8, wipe } from "./bytes.ts";
import { getSuite, suitesCompatible, type CipherSuite } from "./suite.ts";

export const ENVELOPE_VERSION = 1;

/** The public half of a device, as published by the server. */
export interface DeviceRecord {
  deviceId: string;
  userId: string;
  suite: string;
  /** ed25519 public key (32 bytes) ‖ x25519 public key (32 bytes) */
  identityPub: Uint8Array;
  signedPreKeyPub: Uint8Array;
  signedPreKeySig: Uint8Array;
  /** Present only when the server handed out a one-time pre-key. */
  preKeyId?: string;
  preKey?: Uint8Array;
}

/** The private half, held only on this device. */
export interface DeviceSecrets {
  deviceId: string;
  suite: string;
  signingPrivate: Uint8Array;
  signingPublic: Uint8Array;
  agreementPrivate: Uint8Array;
  agreementPublic: Uint8Array;
  signedPreKeyPrivate: Uint8Array;
  signedPreKeyPublic: Uint8Array;
  /** One-time pre-key private halves, by the id published to the server. */
  oneTimePreKeys: Record<string, string>;
}

export interface SealedMessage {
  header: Uint8Array;
  body: Uint8Array;
  /** deviceId → wrapped content key, ready to POST. */
  keys: Record<string, Uint8Array>;
}

interface Header {
  v: number;
  suite: string;
  epk: string;
  n: string;
  sender: string;
  ts: number;
}

interface WrapEntry {
  /** Which of the recipient's keys was used: a pre-key id, or "spk". */
  rk: string;
  /** The wrapped content key. */
  w: string;
  /**
   * Ephemeral public key for this wrap. Normally the same one as the header
   * carries; a re-wrap for a device added later brings its own, because it
   * happens long after the message was written.
   */
  e?: string;
}

/** Deterministic JSON, so both sides authenticate exactly the same bytes. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}

function bodyAad(header: Header, channelId: string): Uint8Array {
  return utf8(`kivora/v${ENVELOPE_VERSION}|${channelId}|${canonical(header)}`);
}

function wrapInfo(suiteId: string, channelId: string, deviceId: string, refKey: string): Uint8Array {
  return utf8(`kivora-wrap/v${ENVELOPE_VERSION}|${suiteId}|${channelId}|${deviceId}|${refKey}`);
}

const WRAP_SALT = utf8("kivora-wrap-salt/v1");

/** The exact bytes a device signs to bind a pre-key to its identity. */
export function preKeyBindingMessage(
  suiteId: string,
  agreementPublic: Uint8Array,
  preKeyPublic: Uint8Array,
): Uint8Array {
  return concat(utf8(`kivora-prekey/v${ENVELOPE_VERSION}|${suiteId}|`), agreementPublic, preKeyPublic);
}

/**
 * Verify that a device really vouched for the pre-key the server handed us.
 * This is the check that keeps a hostile server from substituting a pre-key it
 * generated and reading the conversation that follows.
 */
export async function verifyDevice(suite: CipherSuite, device: DeviceRecord): Promise<boolean> {
  if (!suite.signatures) return true;
  if (device.identityPub.length !== 64) return false;
  const signingPub = device.identityPub.subarray(0, 32);
  const agreementPub = device.identityPub.subarray(32, 64);
  return suite.verify(
    signingPub,
    preKeyBindingMessage(device.suite, agreementPub, device.signedPreKeyPub),
    device.signedPreKeySig,
  );
}

export interface SealOptions {
  /** Refuse to send when a recipient device fails its signature check. */
  strict?: boolean;
}

export async function seal(
  suiteId: string,
  channelId: string,
  sender: DeviceSecrets,
  recipients: DeviceRecord[],
  plaintext: Uint8Array,
  options: SealOptions = {},
): Promise<SealedMessage> {
  const suite = getSuite(suiteId);
  const ephemeral = await suite.generateKeyPair();

  const nonce = suite.randomBytes(suite.nonceLength);
  const cek = suite.randomBytes(suite.keyLength);

  const header: Header = {
    v: ENVELOPE_VERSION,
    suite: suiteId,
    epk: toBase64(ephemeral.publicKey),
    n: toBase64(nonce),
    sender: sender.deviceId,
    ts: Date.now(),
  };
  const aad = bodyAad(header, channelId);
  const body = await suite.seal(cek, nonce, plaintext, aad);

  const keys: Record<string, Uint8Array> = {};
  for (const device of recipients) {
    if (!suitesCompatible(device.suite, suiteId)) {
      // A device on a different suite simply cannot read this message. Skipping
      // it is visible in the UI as "not delivered to N devices" rather than
      // silently downgrading everyone to the weaker suite.
      continue;
    }
    if (!(await verifyDevice(suite, device))) {
      if (options.strict) {
        throw new Error(`device ${device.deviceId} failed its pre-key signature check`);
      }
      continue;
    }

    const usePreKey = device.preKey && device.preKey.length > 0;
    const target = usePreKey ? device.preKey! : device.signedPreKeyPub;
    const refKey = usePreKey ? device.preKeyId! : "spk";

    const ikm = concat(
      await suite.agree(ephemeral.privateKey, target),
      await suite.agree(sender.agreementPrivate, target),
    );
    const derived = await suite.kdf(
      ikm,
      WRAP_SALT,
      wrapInfo(suiteId, channelId, device.deviceId, refKey),
      suite.keyLength + suite.nonceLength,
    );
    const kek = derived.subarray(0, suite.keyLength);
    const wrapNonce = derived.subarray(suite.keyLength);

    const wrapped = await suite.seal(kek, wrapNonce, cek, utf8(device.deviceId));
    const entry: WrapEntry = { rk: refKey, w: toBase64(wrapped) };
    keys[device.deviceId] = utf8(JSON.stringify(entry));
    wipe(ikm, derived);
  }

  wipe(cek, ephemeral.privateKey);
  return { header: utf8(canonical(header)), body, keys };
}

export interface OpenInput {
  channelId: string;
  header: Uint8Array;
  body: Uint8Array;
  wrappedKey: Uint8Array;
  /** The sender's published device record, for the authentication DH. */
  senderDevice: DeviceRecord;
  recipient: DeviceSecrets;
}

/**
 * Recover the content key alone. Split out from `openSealed` because adding a
 * new device needs the key without needing the plaintext.
 */
export async function unwrapContentKey(input: OpenInput): Promise<{ cek: Uint8Array; header: Header }> {
  const header = JSON.parse(new TextDecoder().decode(input.header)) as Header;
  if (header.v !== ENVELOPE_VERSION) {
    throw new Error(`unsupported envelope version ${header.v}`);
  }
  if (!suitesCompatible(header.suite, input.recipient.suite)) {
    throw new Error(`message uses ${header.suite}, this device speaks ${input.recipient.suite}`);
  }
  if (header.sender !== input.senderDevice.deviceId) {
    throw new Error("the sender named in the header is not the device we were given");
  }
  const suite = getSuite(header.suite);

  const entry = JSON.parse(new TextDecoder().decode(input.wrappedKey)) as WrapEntry;
  let privateKey: Uint8Array;
  if (entry.rk === "spk") {
    privateKey = input.recipient.signedPreKeyPrivate;
  } else {
    const stored = input.recipient.oneTimePreKeys[entry.rk];
    if (!stored) {
      throw new Error(
        `one-time pre-key "${entry.rk}" is not on this device — it was consumed or never generated here`,
      );
    }
    privateKey = fromBase64(stored);
  }

  if (input.senderDevice.identityPub.length !== 64) {
    throw new Error("sender identity key has an unexpected shape");
  }
  const senderAgreementPub = input.senderDevice.identityPub.subarray(32, 64);

  const ikm = concat(
    await suite.agree(privateKey, fromBase64(entry.e ?? header.epk)),
    await suite.agree(privateKey, senderAgreementPub),
  );
  const derived = await suite.kdf(
    ikm,
    WRAP_SALT,
    wrapInfo(header.suite, input.channelId, input.recipient.deviceId, entry.rk),
    suite.keyLength + suite.nonceLength,
  );
  const kek = derived.subarray(0, suite.keyLength);
  const wrapNonce = derived.subarray(suite.keyLength);

  const cek = await suite.open(kek, wrapNonce, fromBase64(entry.w), utf8(input.recipient.deviceId));
  wipe(ikm, derived);
  return { cek, header };
}

export async function openSealed(input: OpenInput): Promise<Uint8Array> {
  const { cek, header } = await unwrapContentKey(input);
  const suite = getSuite(header.suite);
  const aad = bodyAad(header, input.channelId);
  const plaintext = await suite.open(cek, fromBase64(header.n), input.body, aad);
  wipe(cek);
  return plaintext;
}

/**
 * Re-wrap a content key for another device of the same user — how a newly
 * added device gets access to existing history without any key ever passing
 * through the server in the clear.
 */
export async function rewrapFor(
  suiteId: string,
  channelId: string,
  sender: DeviceSecrets,
  target: DeviceRecord,
  contentKey: Uint8Array,
): Promise<Uint8Array> {
  const suite = getSuite(suiteId);
  const ephemeral = await suite.generateKeyPair();
  const usePreKey = target.preKey && target.preKey.length > 0;
  const key = usePreKey ? target.preKey! : target.signedPreKeyPub;
  const refKey = usePreKey ? target.preKeyId! : "spk";

  const ikm = concat(
    await suite.agree(ephemeral.privateKey, key),
    await suite.agree(sender.agreementPrivate, key),
  );
  const derived = await suite.kdf(
    ikm,
    WRAP_SALT,
    wrapInfo(suiteId, channelId, target.deviceId, refKey),
    suite.keyLength + suite.nonceLength,
  );
  const wrapped = await suite.seal(
    derived.subarray(0, suite.keyLength),
    derived.subarray(suite.keyLength),
    contentKey,
    utf8(target.deviceId),
  );
  const entry: WrapEntry = { rk: refKey, w: toBase64(wrapped), e: toBase64(ephemeral.publicKey) };
  wipe(ikm, derived, ephemeral.privateKey);
  return utf8(JSON.stringify(entry));
}
