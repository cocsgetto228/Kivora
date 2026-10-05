/**
 * Safety numbers.
 *
 * End-to-end encryption only means something if you know whose key you have.
 * Two people compare this number out of band — read it aloud, scan it — and if
 * it matches, no one is standing in the middle, whatever the server does.
 *
 * The construction is deliberately symmetric: both sides compute the same
 * number regardless of who starts the comparison.
 */

import { concat, utf8 } from "./bytes.ts";
import { sha256 } from "./sha256.ts";

const ITERATIONS = 5200;

function iterate(identity: Uint8Array, stableId: string): Uint8Array {
  let h = concat(utf8("kivora-safety/v1"), identity, utf8(stableId));
  for (let i = 0; i < ITERATIONS; i++) h = sha256(concat(h, identity));
  return h;
}

function toDigits(hash: Uint8Array): string {
  // Five 5-digit groups per side, in the style users are already used to.
  let out = "";
  for (let i = 0; i < 25; i += 5) {
    let chunk = 0;
    for (let j = 0; j < 5; j++) chunk = chunk * 256 + hash[i + j]!;
    out += (chunk % 100000).toString().padStart(5, "0");
  }
  return out;
}

/**
 * The number both parties should see. `identityA`/`identityB` are the 64-byte
 * published identity keys; the ids make the ordering deterministic.
 */
export function safetyNumber(
  identityA: Uint8Array,
  idA: string,
  identityB: Uint8Array,
  idB: string,
): string {
  const a = toDigits(iterate(identityA, idA));
  const b = toDigits(iterate(identityB, idB));
  const joined = a < b ? a + b : b + a;
  return (joined.match(/.{1,5}/g) ?? []).join(" ");
}

/** A short fingerprint for one device, for the "your devices" list. */
export function deviceFingerprint(identityPub: Uint8Array): string {
  const h = sha256(concat(utf8("kivora-device/v1"), identityPub));
  return (Array.from(h.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("").match(/.{1,4}/g) ?? []).join("-");
}

/**
 * The short authentication string for a call.
 *
 * WebRTC media is encrypted by DTLS-SRTP between the two browsers, which is
 * fine against a passive network and useless against the signalling server:
 * the server relays the DTLS *fingerprints*, so a server that swaps them for
 * its own terminates both legs and hears everything, while both ends still see
 * a padlock. Encrypted-but-unauthenticated is the shape of every DTLS MITM.
 *
 * This binds the media to the identities. Both sides hash the set of
 * fingerprints actually in use; a server that substituted one produces a
 * different string on each end, and it cannot make them agree without breaking
 * SHA-256.
 *
 * Sorting before hashing is what makes it symmetric — neither side has to be
 * "the caller" for the numbers to line up.
 */
export function callAuthString(fingerprints: string[]): string {
  const canonical = fingerprints
    .map((f) => f.trim().toLowerCase().replace(/[^0-9a-f]/g, ""))
    .filter((f) => f.length > 0)
    .sort();
  if (canonical.length < 2) return "";

  let h = concat(utf8("kivora-call-sas/v1"), utf8(canonical.join("|")));
  // A few thousand rounds: not a password, but enough that grinding for a
  // fingerprint whose SAS collides with a target is not a laptop-minutes job.
  for (let i = 0; i < 4096; i++) h = sha256(h);

  // Four groups of four digits: long enough that guessing is hopeless, short
  // enough that two people will actually read it to each other.
  let out: string[] = [];
  for (let i = 0; i < 8; i += 2) {
    out.push((((h[i]! << 8) | h[i + 1]!) % 10000).toString().padStart(4, "0"));
  }
  return out.join(" ");
}
