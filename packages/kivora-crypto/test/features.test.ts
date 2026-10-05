import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callAuthString,
  createDeviceKeys,
  decodePayload,
  defaultSuiteId,
  encodePayload,
  fromBase64,
  fromUtf8,
  openFile,
  openSealed,
  seal,
  sealFile,
  summarize,
  toBase64,
  TrustStore,
  utf8,
  type DeviceRecord,
} from "../src/index.ts";

async function makeDevice(suiteId: string, deviceId: string, userId: string) {
  const { secrets, published } = await createDeviceKeys(suiteId, 2);
  secrets.deviceId = deviceId;
  const record: DeviceRecord = {
    deviceId,
    userId,
    suite: published.suite,
    identityPub: fromBase64(published.identityPub),
    signedPreKeyPub: fromBase64(published.signedPreKeyPub),
    signedPreKeySig: fromBase64(published.signedPreKeySig),
  };
  return { secrets, published, record };
}

test("a file round-trips and is bound to its channel", async () => {
  const suiteId = defaultSuiteId();
  const photo = new Uint8Array(4096);
  for (let i = 0; i < photo.length; i++) photo[i] = (i * 31) % 256;

  const sealed = await sealFile(suiteId, "c_1", photo);
  assert.notDeepEqual(sealed.ciphertext.subarray(0, 64), photo.subarray(0, 64));
  assert.ok(sealed.ciphertext.length > photo.length, "the tag adds length");

  assert.deepEqual(await openFile(sealed.key, "c_1", sealed.ciphertext), photo);

  // The same key in another channel must not open it.
  await assert.rejects(() => openFile(sealed.key, "c_2", sealed.ciphertext), /authentication failed/);

  // Nor must a flipped byte.
  const tampered = Uint8Array.from(sealed.ciphertext);
  tampered[10] ^= 0x20;
  await assert.rejects(() => openFile(sealed.key, "c_1", tampered), /authentication failed/);
});

test("an attachment key travels inside the encrypted message, never beside it", async () => {
  const suiteId = defaultSuiteId();
  const alice = await makeDevice(suiteId, "d_a", "u_a");
  const bob = await makeDevice(suiteId, "d_b", "u_b");

  const photo = utf8("pretend this is a jpeg");
  const file = await sealFile(suiteId, "c_1", photo);

  const payload = encodePayload({
    text: "смотри",
    attachments: [
      {
        id: "f_1",
        kind: "image",
        mime: "image/jpeg",
        name: "закат.jpg",
        size: photo.length,
        width: 800,
        height: 600,
        key: file.key,
      },
    ],
  });

  const sealedMessage = await seal(suiteId, "c_1", alice.secrets, [bob.record], payload);

  // What the server would store carries no trace of the file key.
  const onTheWire = toBase64(sealedMessage.body) + toBase64(sealedMessage.header);
  assert.ok(!onTheWire.includes(file.key.k), "the file key must not be visible in the stored bytes");

  const opened = await openSealed({
    channelId: "c_1",
    header: sealedMessage.header,
    body: sealedMessage.body,
    wrappedKey: sealedMessage.keys["d_b"]!,
    senderDevice: alice.record,
    recipient: bob.secrets,
  });
  const decoded = decodePayload(opened);
  assert.equal(decoded.text, "смотри");
  assert.equal(decoded.attachments?.[0]?.name, "закат.jpg");

  const recovered = await openFile(decoded.attachments![0]!.key, "c_1", file.ciphertext);
  assert.equal(fromUtf8(recovered), "pretend this is a jpeg");
});

test("payloads stay readable when the format predates them", () => {
  const legacy = decodePayload(utf8("просто текст без обёртки"));
  assert.equal(legacy.text, "просто текст без обёртки");
  assert.equal(legacy.attachments, undefined);

  // Something that starts with { but is not a payload must not be lost either.
  const notJson = decodePayload(utf8("{ не json"));
  assert.equal(notJson.text, "{ не json");
});

test("the chat-list summary describes attachments when there is no text", () => {
  assert.deepEqual(summarize({ v: 1, text: "привет" }), { icon: null, text: "привет" });
  const withPhoto = summarize({
    v: 1,
    text: "",
    attachments: [
      { id: "f", kind: "image", mime: "image/png", name: "фото.png", size: 1, key: { v: 1, suite: "x", k: "", n: "" } },
    ],
  });
  assert.equal(withPhoto.icon, "image");
  assert.equal(withPhoto.text, "фото.png");
});

test("the trust store distinguishes unknown, verified and changed", async () => {
  const suiteId = defaultSuiteId();
  const bob = await makeDevice(suiteId, "d_b", "u_b");
  const impostor = await makeDevice(suiteId, "d_x", "u_x");

  const trust = new TrustStore();
  assert.equal(trust.inspect("u_b", bob.record.identityPub), "unknown");

  trust.markVerified("u_b", bob.record.identityPub);
  assert.equal(trust.inspect("u_b", bob.record.identityPub), "verified");
  assert.equal(trust.verifiedCount(), 1);

  // A different key for the same contact is the case that matters.
  assert.equal(trust.inspect("u_b", impostor.record.identityPub), "changed");

  trust.noteChange("u_b", impostor.record.identityPub);
  assert.equal(trust.inspect("u_b", impostor.record.identityPub), "changed");
  assert.equal(trust.record("u_b")?.previous, toBase64(bob.record.identityPub));

  // Acknowledging drops the warning but must not pretend the key was checked.
  trust.acknowledgeChange("u_b");
  assert.equal(trust.record("u_b")?.changedAt, undefined, "the warning should be cleared");
  assert.equal(trust.record("u_b")?.verifiedAt, 0, "acknowledging must not backdate a verification");

  trust.clear("u_b");
  assert.equal(trust.inspect("u_b", bob.record.identityPub), "unknown");
});

test("the trust store survives serialisation", async () => {
  const suiteId = defaultSuiteId();
  const bob = await makeDevice(suiteId, "d_b", "u_b");

  const trust = new TrustStore();
  trust.markVerified("u_b", bob.record.identityPub);
  const restored = TrustStore.deserialize(trust.serialize());
  assert.equal(restored.inspect("u_b", bob.record.identityPub), "verified");

  // Garbage in storage means "nothing verified", not a crash.
  assert.equal(TrustStore.deserialize("not json").verifiedCount(), 0);
  assert.equal(TrustStore.deserialize(null).verifiedCount(), 0);
});

test("the call authentication string is symmetric and catches a swapped fingerprint", () => {
  const alice = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
  const bob = "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";
  const server = "DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF:DE:AD:BE:EF";

  // Both ends see the same pair, in whatever order they happen to hold it.
  assert.equal(callAuthString([alice, bob]), callAuthString([bob, alice]));
  assert.notEqual(callAuthString([alice, bob]), "");

  // A server in the middle terminates two legs: Alice is really talking to the
  // server, and so is Bob. Neither of their strings matches the other's, which
  // is the whole point — the padlock alone would have looked identical.
  const aliceSees = callAuthString([alice, server]);
  const bobSees = callAuthString([bob, server]);
  assert.notEqual(aliceSees, bobSees);
  assert.notEqual(aliceSees, callAuthString([alice, bob]));

  // Formatting is not accidental: it has to be readable aloud.
  assert.match(callAuthString([alice, bob]), /^\d{4} \d{4} \d{4} \d{4}$/);

  // Punctuation and case in a fingerprint are noise, not identity.
  assert.equal(callAuthString([alice, bob]), callAuthString([alice.toLowerCase(), bob.replace(/:/g, "")]));

  // One participant is not a call.
  assert.equal(callAuthString([alice]), "");
});
