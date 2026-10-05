import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDeviceKeys,
  seal,
  openSealed,
  rewrapFor,
  unwrapContentKey,
  verifyDevice,
  getSuite,
  listSuites,
  registerSuite,
  negotiate,
  suitesCompatible,
  defaultSuiteId,
  safetyNumber,
  deviceFingerprint,
  serializeSecrets,
  deserializeSecrets,
  utf8,
  fromUtf8,
  fromBase64,
  toBase64,
  type DeviceRecord,
  type DeviceSecrets,
} from "../src/index.ts";

/** Build a device the way the client does: generate keys, then take the id the
 *  server would have assigned. */
async function makeDevice(suiteId: string, deviceId: string, userId: string) {
  const { secrets, published } = await createDeviceKeys(suiteId, 3);
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

function withPreKey(device: Awaited<ReturnType<typeof makeDevice>>, index = 0): DeviceRecord {
  const pk = device.published.preKeys[index]!;
  return { ...device.record, preKeyId: pk.id, preKey: fromBase64(pk.pub) };
}

for (const suiteId of ["kivora.x25519-xchacha20poly1305.v1", "kivora.x25519-aes256gcm.v1"]) {
  test(`round-trip through ${suiteId}`, async () => {
    const alice = await makeDevice(suiteId, "d_alice", "u_alice");
    const bob = await makeDevice(suiteId, "d_bob", "u_bob");
    const message = utf8("Привет! Это сообщение сервер прочитать не может.");

    const sealed = await seal(suiteId, "c_1", alice.secrets, [alice.record, bob.record], message, {
      strict: true,
    });

    assert.ok(sealed.keys["d_bob"], "bob must get a wrapped key");
    assert.ok(sealed.keys["d_alice"], "the sender's own devices get one too");
    assert.notDeepEqual(sealed.body, message, "body must not be plaintext");

    const opened = await openSealed({
      channelId: "c_1",
      header: sealed.header,
      body: sealed.body,
      wrappedKey: sealed.keys["d_bob"]!,
      senderDevice: alice.record,
      recipient: bob.secrets,
    });
    assert.equal(fromUtf8(opened), fromUtf8(message));
  });
}

test("one-time pre-keys are used when the server offers them", async () => {
  const suiteId = defaultSuiteId();
  const alice = await makeDevice(suiteId, "d_alice", "u_alice");
  const bob = await makeDevice(suiteId, "d_bob", "u_bob");

  const sealed = await seal(suiteId, "c_1", alice.secrets, [withPreKey(bob)], utf8("hi"));
  const entry = JSON.parse(fromUtf8(sealed.keys["d_bob"]!)) as { rk: string };
  assert.equal(entry.rk, bob.published.preKeys[0]!.id, "the wrap must name the pre-key it used");

  const opened = await openSealed({
    channelId: "c_1",
    header: sealed.header,
    body: sealed.body,
    wrappedKey: sealed.keys["d_bob"]!,
    senderDevice: alice.record,
    recipient: bob.secrets,
  });
  assert.equal(fromUtf8(opened), "hi");
});

test("a third party with the ciphertext learns nothing", async () => {
  const suiteId = defaultSuiteId();
  const alice = await makeDevice(suiteId, "d_alice", "u_alice");
  const bob = await makeDevice(suiteId, "d_bob", "u_bob");
  const mallory = await makeDevice(suiteId, "d_mallory", "u_mallory");

  const sealed = await seal(suiteId, "c_1", alice.secrets, [bob.record], utf8("secret plan"));
  assert.equal(sealed.keys["d_mallory"], undefined, "no key for a non-recipient");

  // Even handed Bob's wrapped key, Mallory cannot unwrap it.
  await assert.rejects(
    () =>
      openSealed({
        channelId: "c_1",
        header: sealed.header,
        body: sealed.body,
        wrappedKey: sealed.keys["d_bob"]!,
        senderDevice: alice.record,
        recipient: mallory.secrets,
      }),
    /authentication failed/,
  );
});

test("the channel id is authenticated: a message cannot be replayed elsewhere", async () => {
  const suiteId = defaultSuiteId();
  const alice = await makeDevice(suiteId, "d_alice", "u_alice");
  const bob = await makeDevice(suiteId, "d_bob", "u_bob");
  const sealed = await seal(suiteId, "c_private", alice.secrets, [bob.record], utf8("payload"));

  await assert.rejects(
    () =>
      openSealed({
        channelId: "c_public",
        header: sealed.header,
        body: sealed.body,
        wrappedKey: sealed.keys["d_bob"]!,
        senderDevice: alice.record,
        recipient: bob.secrets,
      }),
    /authentication failed/,
  );
});

test("tampering with the ciphertext is detected", async () => {
  const suiteId = defaultSuiteId();
  const alice = await makeDevice(suiteId, "d_alice", "u_alice");
  const bob = await makeDevice(suiteId, "d_bob", "u_bob");
  const sealed = await seal(suiteId, "c_1", alice.secrets, [bob.record], utf8("transfer 10"));

  sealed.body[2] ^= 0x40;
  await assert.rejects(
    () =>
      openSealed({
        channelId: "c_1",
        header: sealed.header,
        body: sealed.body,
        wrappedKey: sealed.keys["d_bob"]!,
        senderDevice: alice.record,
        recipient: bob.secrets,
      }),
    /authentication failed/,
  );
});

test("a forged sender is rejected", async () => {
  const suiteId = defaultSuiteId();
  const alice = await makeDevice(suiteId, "d_alice", "u_alice");
  const bob = await makeDevice(suiteId, "d_bob", "u_bob");
  const mallory = await makeDevice(suiteId, "d_mallory", "u_mallory");

  // Mallory seals a message but claims to be Alice by presenting her record.
  const sealed = await seal(suiteId, "c_1", mallory.secrets, [bob.record], utf8("send me money"));
  await assert.rejects(
    () =>
      openSealed({
        channelId: "c_1",
        header: sealed.header,
        body: sealed.body,
        wrappedKey: sealed.keys["d_bob"]!,
        senderDevice: alice.record,
        recipient: bob.secrets,
      }),
    /not the device we were given/,
  );
});

test("a server-substituted pre-key fails its signature check", async () => {
  const suiteId = defaultSuiteId();
  const suite = getSuite(suiteId);
  const alice = await makeDevice(suiteId, "d_alice", "u_alice");
  const bob = await makeDevice(suiteId, "d_bob", "u_bob");
  const attacker = await makeDevice(suiteId, "d_evil", "u_evil");

  assert.equal(await verifyDevice(suite, bob.record), true);

  // The server swaps in a pre-key it controls, keeping Bob's identity key.
  const tampered: DeviceRecord = { ...bob.record, signedPreKeyPub: attacker.record.signedPreKeyPub };
  assert.equal(await verifyDevice(suite, tampered), false);

  await assert.rejects(
    () => seal(suiteId, "c_1", alice.secrets, [tampered], utf8("hi"), { strict: true }),
    /failed its pre-key signature check/,
  );
});

test("a device added later can be given history through a re-wrap", async () => {
  const suiteId = defaultSuiteId();
  const alice = await makeDevice(suiteId, "d_alice", "u_alice");
  const bob = await makeDevice(suiteId, "d_bob", "u_bob");
  const aliceLaptop = await makeDevice(suiteId, "d_alice2", "u_alice");

  const sealed = await seal(suiteId, "c_1", alice.secrets, [alice.record, bob.record], utf8("old news"));
  // The laptop has no key for this message yet.
  assert.equal(sealed.keys["d_alice2"], undefined);

  const { cek } = await unwrapContentKey({
    channelId: "c_1",
    header: sealed.header,
    body: sealed.body,
    wrappedKey: sealed.keys["d_alice"]!,
    senderDevice: alice.record,
    recipient: alice.secrets,
  });
  const rewrapped = await rewrapFor(suiteId, "c_1", alice.secrets, aliceLaptop.record, cek);

  const opened = await openSealed({
    channelId: "c_1",
    header: sealed.header,
    body: sealed.body,
    wrappedKey: rewrapped,
    senderDevice: alice.record,
    recipient: aliceLaptop.secrets,
  });
  assert.equal(fromUtf8(opened), "old news");
});

test("devices on an incompatible suite are skipped, never downgraded", async () => {
  const alice = await makeDevice("kivora.x25519-xchacha20poly1305.v1", "d_alice", "u_alice");
  const bob = await makeDevice("kivora.x25519-aes256gcm.v1", "d_bob", "u_bob");

  const sealed = await seal(
    "kivora.x25519-xchacha20poly1305.v1",
    "c_1",
    alice.secrets,
    [alice.record, bob.record],
    utf8("hello"),
  );
  assert.ok(sealed.keys["d_alice"]);
  assert.equal(sealed.keys["d_bob"], undefined, "a device on another suite gets no key");
});

test("suite registry validates ids and supports negotiation", () => {
  assert.ok(listSuites().length >= 2);
  assert.throws(
    () => registerSuite({ ...getSuite(defaultSuiteId()), id: "Not A Suite" }),
    /must look like/,
  );
  assert.throws(
    () => registerSuite({ ...getSuite(defaultSuiteId()), id: "acme.weak.v1", keyLength: 8 }),
    /below the minimum/,
  );

  assert.equal(suitesCompatible("a.b.v1", "a.b.v1"), true);
  assert.equal(suitesCompatible("a.b.v1", "a.b.v2"), false);
  assert.equal(
    negotiate(["acme.x.v1", "acme.x.v2"], ["acme.x.v2", "other.y.v1"]),
    "acme.x.v2",
    "negotiation picks the highest shared version",
  );
  assert.equal(negotiate(["acme.x.v1"], ["other.y.v1"]), null);
});

test("a custom suite plugs in without touching any other code", async () => {
  const base = getSuite("kivora.x25519-xchacha20poly1305.v1");
  let sealCalls = 0;

  // A third-party suite: same primitives, different id and a counter to prove
  // that the envelope really went through this implementation.
  const custom = {
    ...base,
    id: "acme.custom-xchacha.v1",
    label: "Acme custom",
    async seal(key: Uint8Array, nonce: Uint8Array, pt: Uint8Array, aad: Uint8Array) {
      sealCalls++;
      return base.seal(key, nonce, pt, aad);
    },
  };
  registerSuite(custom);

  const alice = await makeDevice(custom.id, "d_a", "u_a");
  const bob = await makeDevice(custom.id, "d_b", "u_b");
  const sealed = await seal(custom.id, "c_1", alice.secrets, [bob.record], utf8("plugged in"));
  const opened = await openSealed({
    channelId: "c_1",
    header: sealed.header,
    body: sealed.body,
    wrappedKey: sealed.keys["d_b"]!,
    senderDevice: alice.record,
    recipient: bob.secrets,
  });
  assert.equal(fromUtf8(opened), "plugged in");
  assert.ok(sealCalls > 0, "the custom implementation must actually have been used");
});

test("device secrets survive a serialize/deserialize cycle", async () => {
  const alice = await makeDevice(defaultSuiteId(), "d_alice", "u_alice");
  const restored: DeviceSecrets = deserializeSecrets(serializeSecrets(alice.secrets));
  assert.deepEqual(restored.agreementPrivate, alice.secrets.agreementPrivate);
  assert.deepEqual(restored.oneTimePreKeys, alice.secrets.oneTimePreKeys);

  const bob = await makeDevice(defaultSuiteId(), "d_bob", "u_bob");
  const sealed = await seal(defaultSuiteId(), "c_1", bob.secrets, [alice.record], utf8("after restart"));
  const opened = await openSealed({
    channelId: "c_1",
    header: sealed.header,
    body: sealed.body,
    wrappedKey: sealed.keys["d_alice"]!,
    senderDevice: bob.record,
    recipient: restored,
  });
  assert.equal(fromUtf8(opened), "after restart");
});

test("safety numbers are symmetric and change when a key changes", async () => {
  const alice = await makeDevice(defaultSuiteId(), "d_a", "u_a");
  const bob = await makeDevice(defaultSuiteId(), "d_b", "u_b");
  const evil = await makeDevice(defaultSuiteId(), "d_e", "u_e");

  const ab = safetyNumber(alice.record.identityPub, "u_a", bob.record.identityPub, "u_b");
  const ba = safetyNumber(bob.record.identityPub, "u_b", alice.record.identityPub, "u_a");
  assert.equal(ab, ba, "both sides must read the same number");
  assert.match(ab, /^[\d ]+$/);

  const spoofed = safetyNumber(alice.record.identityPub, "u_a", evil.record.identityPub, "u_b");
  assert.notEqual(ab, spoofed, "a swapped key must produce a different number");

  assert.match(deviceFingerprint(alice.record.identityPub), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
});

test("base64 helpers round-trip binary data", () => {
  const data = new Uint8Array(257);
  for (let i = 0; i < data.length; i++) data[i] = i % 256;
  assert.deepEqual(fromBase64(toBase64(data)), data);
});
