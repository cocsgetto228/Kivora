import { test } from "node:test";
import assert from "node:assert/strict";

import { fromHex, toHex, utf8 } from "../src/bytes.ts";
import { publicKeyFromSeed, sign, verify, generateKeyPair } from "../src/ed25519.ts";

// RFC 8032 section 7.1 test vectors.
const vectors = [
  {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    msg: "",
    sig:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    msg: "72",
    sig:
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da" +
      "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    pub: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    msg: "af82",
    sig:
      "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac" +
      "18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
];

test("Ed25519 matches RFC 8032 test vectors", async () => {
  for (const v of vectors) {
    const seed = fromHex(v.seed);
    const msg = fromHex(v.msg);
    assert.equal(toHex(await publicKeyFromSeed(seed)), v.pub, "public key for " + v.seed);
    assert.equal(toHex(await sign(seed, msg)), v.sig, "signature for " + v.seed);
    assert.equal(await verify(fromHex(v.pub), msg, fromHex(v.sig)), true);
  }
});

test("Ed25519 rejects a tampered message and a tampered signature", async () => {
  const kp = await generateKeyPair();
  const msg = utf8("bind this pre-key to this identity");
  const sig = await sign(kp.privateKey, msg);
  assert.equal(await verify(kp.publicKey, msg, sig), true);

  assert.equal(await verify(kp.publicKey, utf8("bind this pre-key to that identity"), sig), false);

  const bad = Uint8Array.from(sig);
  bad[10] ^= 0x01;
  assert.equal(await verify(kp.publicKey, msg, bad), false);

  const other = await generateKeyPair();
  assert.equal(await verify(other.publicKey, msg, sig), false);
});

test("Ed25519 rejects non-canonical (malleable) signatures", async () => {
  const kp = await generateKeyPair();
  const msg = utf8("x");
  const sig = await sign(kp.privateKey, msg);
  const malleable = Uint8Array.from(sig);
  malleable[63] = malleable[63]! | 0x80; // pushes s above the group order
  assert.equal(await verify(kp.publicKey, msg, malleable), false);
});
