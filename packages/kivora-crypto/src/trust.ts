/**
 * The trust store: which identity keys this device has actually verified.
 *
 * End-to-end encryption stops a malicious server from *reading* messages. It
 * does not, on its own, stop one from handing you the wrong public key in the
 * first place. The defence against that is a human comparing a safety number
 * out of band — and then the client remembering the answer, so the check has to
 * happen once rather than every time.
 *
 * Three states matter, and the UI shows all three:
 *
 *   unknown   we have seen this key but nobody has confirmed it
 *   verified  a person compared the number and said it matched
 *   changed   we previously recorded a different key for this contact
 *
 * "changed" is the important one. A reinstalled phone produces it innocently,
 * and so does an attacker inserting themselves. The client cannot tell those
 * apart, so it must not silently pick one — it says the key changed and asks
 * for a fresh comparison.
 */

import { equalCT, fromBase64, toBase64 } from "./bytes.ts";
import { safetyNumber } from "./safety.ts";

export type TrustState = "unknown" | "verified" | "changed";

export interface TrustRecord {
  /** The 64-byte published identity key, base64. */
  identityPub: string;
  verifiedAt: number;
  /** Set when the key changed after being recorded, until acknowledged. */
  previous?: string;
  changedAt?: number;
}

export class TrustStore {
  private records = new Map<string, TrustRecord>();

  static deserialize(json: string | null | undefined): TrustStore {
    const store = new TrustStore();
    if (!json) return store;
    try {
      const raw = JSON.parse(json) as Record<string, TrustRecord>;
      for (const [userId, record] of Object.entries(raw)) {
        if (record && typeof record.identityPub === "string") store.records.set(userId, record);
      }
    } catch {
      /* an unreadable trust file means "nothing verified", never a crash */
    }
    return store;
  }

  serialize(): string {
    return JSON.stringify(Object.fromEntries(this.records));
  }

  /**
   * Look at a contact's current key and report where we stand. Called on every
   * message decrypt, so it must be cheap: it is a map lookup and a compare.
   */
  inspect(userId: string, identityPub: Uint8Array): TrustState {
    const record = this.records.get(userId);
    if (!record) return "unknown";
    if (equalCT(fromBase64(record.identityPub), identityPub)) {
      return record.changedAt ? "changed" : "verified";
    }
    return "changed";
  }

  /** Record that the key changed, keeping the old one for the warning. */
  noteChange(userId: string, identityPub: Uint8Array): void {
    const record = this.records.get(userId);
    if (!record) return;
    const encoded = toBase64(identityPub);
    if (record.identityPub === encoded) return;
    this.records.set(userId, {
      identityPub: encoded,
      verifiedAt: 0,
      previous: record.identityPub,
      changedAt: Date.now(),
    });
  }

  /** A human compared the safety number and said it matched. */
  markVerified(userId: string, identityPub: Uint8Array): void {
    this.records.set(userId, { identityPub: toBase64(identityPub), verifiedAt: Date.now() });
  }

  /** Undo a verification — used when the user wants to re-check from scratch. */
  clear(userId: string): void {
    this.records.delete(userId);
  }

  /** Dismiss the "key changed" banner without claiming the key is verified. */
  acknowledgeChange(userId: string): void {
    const record = this.records.get(userId);
    if (!record) return;
    this.records.set(userId, { identityPub: record.identityPub, verifiedAt: 0 });
  }

  record(userId: string): TrustRecord | undefined {
    return this.records.get(userId);
  }

  verifiedCount(): number {
    let n = 0;
    for (const record of this.records.values()) if (record.verifiedAt > 0) n++;
    return n;
  }
}

/**
 * The number two people compare. Re-exported here so the verification screen
 * imports one module rather than two.
 */
export { safetyNumber };
