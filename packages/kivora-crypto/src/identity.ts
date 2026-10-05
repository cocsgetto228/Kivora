/**
 * Device identity: generating a device's keys, publishing the public halves,
 * and keeping the private halves where only this device can reach them.
 *
 * A "device" here is one installation — this laptop, that phone, this browser
 * profile. Each has its own long-term keys, so revoking a lost laptop does not
 * mean rotating everything everywhere, and losing one device does not expose
 * the others' history.
 */

import { fromBase64, toBase64 } from "./bytes.ts";
import { getSuite } from "./suite.ts";
import { preKeyBindingMessage, type DeviceRecord, type DeviceSecrets } from "./envelope.ts";

export const PREKEY_BATCH = 60;
export const PREKEY_LOW_WATER = 15;

export interface PublishedKeys {
  suite: string;
  identityPub: string;
  signedPreKeyPub: string;
  signedPreKeySig: string;
  preKeys: { id: string; pub: string }[];
}

export interface NewDeviceKeys {
  secrets: DeviceSecrets;
  published: PublishedKeys;
}

function newPreKeyId(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return toBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Create everything a fresh installation needs. `deviceId` is empty until the
 * server assigns one; call `attachDeviceId` once it does.
 */
export async function createDeviceKeys(suiteId: string, count = PREKEY_BATCH): Promise<NewDeviceKeys> {
  const suite = getSuite(suiteId);
  const identity = await suite.generateIdentity();
  const signedPreKey = await suite.generateKeyPair();

  const binding = preKeyBindingMessage(suiteId, identity.agreement.publicKey, signedPreKey.publicKey);
  const signature = await suite.sign(identity.signing.privateKey, binding);

  const oneTimePreKeys: Record<string, string> = {};
  const published: { id: string; pub: string }[] = [];
  for (let i = 0; i < count; i++) {
    const kp = await suite.generateKeyPair();
    const id = newPreKeyId();
    oneTimePreKeys[id] = toBase64(kp.privateKey);
    published.push({ id, pub: toBase64(kp.publicKey) });
  }

  // identityPub is the signing key followed by the agreement key: one field on
  // the wire, two keys with different jobs.
  const identityPub = new Uint8Array(64);
  identityPub.set(identity.signing.publicKey, 0);
  identityPub.set(identity.agreement.publicKey, 32);

  return {
    secrets: {
      deviceId: "",
      suite: suiteId,
      signingPrivate: identity.signing.privateKey,
      signingPublic: identity.signing.publicKey,
      agreementPrivate: identity.agreement.privateKey,
      agreementPublic: identity.agreement.publicKey,
      signedPreKeyPrivate: signedPreKey.privateKey,
      signedPreKeyPublic: signedPreKey.publicKey,
      oneTimePreKeys,
    },
    published: {
      suite: suiteId,
      identityPub: toBase64(identityPub),
      signedPreKeyPub: toBase64(signedPreKey.publicKey),
      signedPreKeySig: toBase64(signature),
      preKeys: published,
    },
  };
}

/** Top up the one-time pre-key pool when the server reports it running low. */
export async function replenishPreKeys(
  secrets: DeviceSecrets,
  count = PREKEY_BATCH,
): Promise<{ id: string; pub: string }[]> {
  const suite = getSuite(secrets.suite);
  const fresh: { id: string; pub: string }[] = [];
  for (let i = 0; i < count; i++) {
    const kp = await suite.generateKeyPair();
    const id = newPreKeyId();
    secrets.oneTimePreKeys[id] = toBase64(kp.privateKey);
    fresh.push({ id, pub: toBase64(kp.publicKey) });
  }
  return fresh;
}

/** Drop a consumed pre-key. Keeping used private keys around only widens the
 *  window in which a stolen device can decrypt old traffic. */
export function forgetPreKey(secrets: DeviceSecrets, id: string): void {
  delete secrets.oneTimePreKeys[id];
}

export function serializeSecrets(secrets: DeviceSecrets): string {
  return JSON.stringify({
    deviceId: secrets.deviceId,
    suite: secrets.suite,
    signingPrivate: toBase64(secrets.signingPrivate),
    signingPublic: toBase64(secrets.signingPublic),
    agreementPrivate: toBase64(secrets.agreementPrivate),
    agreementPublic: toBase64(secrets.agreementPublic),
    signedPreKeyPrivate: toBase64(secrets.signedPreKeyPrivate),
    signedPreKeyPublic: toBase64(secrets.signedPreKeyPublic),
    oneTimePreKeys: secrets.oneTimePreKeys,
  });
}

export function deserializeSecrets(json: string): DeviceSecrets {
  const raw = JSON.parse(json) as Record<string, string> & { oneTimePreKeys: Record<string, string> };
  return {
    deviceId: raw.deviceId!,
    suite: raw.suite!,
    signingPrivate: fromBase64(raw.signingPrivate!),
    signingPublic: fromBase64(raw.signingPublic!),
    agreementPrivate: fromBase64(raw.agreementPrivate!),
    agreementPublic: fromBase64(raw.agreementPublic!),
    signedPreKeyPrivate: fromBase64(raw.signedPreKeyPrivate!),
    signedPreKeyPublic: fromBase64(raw.signedPreKeyPublic!),
    oneTimePreKeys: raw.oneTimePreKeys ?? {},
  };
}

/** Turn the server's JSON device record into the shape the envelope wants. */
export function toDeviceRecord(raw: {
  id: string;
  userId: string;
  suite: string;
  identityPub: string;
  signedPreKeyPub: string;
  signedPreKeySig: string;
  preKeyId?: string;
  preKey?: string;
}): DeviceRecord {
  return {
    deviceId: raw.id,
    userId: raw.userId,
    suite: raw.suite,
    identityPub: fromBase64(raw.identityPub),
    signedPreKeyPub: fromBase64(raw.signedPreKeyPub),
    signedPreKeySig: fromBase64(raw.signedPreKeySig),
    preKeyId: raw.preKeyId || undefined,
    preKey: raw.preKey ? fromBase64(raw.preKey) : undefined,
  };
}
