import { test } from "node:test";
import assert from "node:assert/strict";

import { fromHex, toHex, utf8, equalCT } from "../src/bytes.ts";
import { sha256, hmacSha256, hkdf } from "../src/sha256.ts";
import { chacha20, hchacha20, poly1305, seal, open, xseal, xopen } from "../src/chacha20poly1305.ts";
import { scalarMult, scalarMultBase, generateKeyPair, agree } from "../src/x25519.ts";
import { AesGcmSuite } from "../src/suites/aesgcm.ts";

test("SHA-256 matches NIST vectors", () => {
  assert.equal(
    toHex(sha256(utf8("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    toHex(sha256(new Uint8Array(0))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    toHex(sha256(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  // A multi-block message, to exercise the padding path.
  assert.equal(
    toHex(sha256(utf8("a".repeat(1000)))),
    "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
  );
});

test("HMAC-SHA256 matches RFC 4231 vectors", () => {
  assert.equal(
    toHex(hmacSha256(new Uint8Array(20).fill(0x0b), utf8("Hi There"))),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
  assert.equal(
    toHex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"))),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
  // Key longer than the block size must be hashed first.
  assert.equal(
    toHex(hmacSha256(new Uint8Array(131).fill(0xaa), utf8("Test Using Larger Than Block-Size Key - Hash Key First"))),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  );
});

test("HKDF matches RFC 5869 test case 1", () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = fromHex("000102030405060708090a0b0c");
  const info = fromHex("f0f1f2f3f4f5f6f7f8f9");
  assert.equal(
    toHex(hkdf(ikm, salt, info, 42)),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
  );
});

test("HKDF matches RFC 5869 test case 3 (empty salt and info)", () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  assert.equal(
    toHex(hkdf(ikm, new Uint8Array(0), new Uint8Array(0), 42)),
    "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
  );
});

test("ChaCha20 keystream matches RFC 8439 section 2.4.2", () => {
  const key = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const nonce = fromHex("000000000000004a00000000");
  const plaintext = utf8(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  );
  const ct = chacha20(key, nonce, plaintext, 1);
  assert.equal(
    toHex(ct).slice(0, 128),
    "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8",
  );
});

test("Poly1305 matches RFC 8439 section 2.5.2", () => {
  const key = fromHex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
  const tag = poly1305(key, utf8("Cryptographic Forum Research Group"));
  assert.equal(toHex(tag), "a8061dc1305136c6c22b8baf0c0127a9");
});

test("ChaCha20-Poly1305 AEAD matches RFC 8439 section 2.8.2", () => {
  const key = fromHex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
  const nonce = fromHex("070000004041424344454647");
  const ad = fromHex("50515253c0c1c2c3c4c5c6c7");
  const plaintext = utf8(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  );
  const sealed = seal(key, nonce, plaintext, ad);
  assert.equal(
    toHex(sealed.subarray(0, sealed.length - 16)),
    "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116",
  );
  assert.equal(toHex(sealed.subarray(sealed.length - 16)), "1ae10b594f09e26a7e902ecbd0600691");
  assert.deepEqual(open(key, nonce, sealed, ad), plaintext);
});

test("AEAD rejects tampering", () => {
  const key = new Uint8Array(32).fill(7);
  const nonce = new Uint8Array(12).fill(9);
  const ad = utf8("channel-id");
  const sealed = seal(key, nonce, utf8("transfer 10 to bob"), ad);

  const flippedCipher = Uint8Array.from(sealed);
  flippedCipher[3] ^= 0x01;
  assert.throws(() => open(key, nonce, flippedCipher, ad), /authentication failed/);

  const flippedTag = Uint8Array.from(sealed);
  flippedTag[flippedTag.length - 1] ^= 0x80;
  assert.throws(() => open(key, nonce, flippedTag, ad), /authentication failed/);

  // Changing the associated data must also fail: this is what binds a
  // ciphertext to the channel and sender it was written for.
  assert.throws(() => open(key, nonce, sealed, utf8("other-channel")), /authentication failed/);
});

test("HChaCha20 matches the CFRG draft vector", () => {
  const key = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const nonce = fromHex("000000090000004a0000000031415927");
  assert.equal(
    toHex(hchacha20(key, nonce)),
    "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc",
  );
});

test("XChaCha20-Poly1305 round-trips and is nonce-sensitive", () => {
  const key = new Uint8Array(32).fill(3);
  const nonce = new Uint8Array(24).fill(5);
  const msg = utf8("привет, это сообщение целиком зашифровано на клиенте");
  const ad = utf8("aad");
  const sealed = xseal(key, nonce, msg, ad);
  assert.deepEqual(xopen(key, nonce, sealed, ad), msg);

  const otherNonce = Uint8Array.from(nonce);
  otherNonce[0] ^= 1;
  assert.throws(() => xopen(key, otherNonce, sealed, ad), /authentication failed/);
});

test("X25519 matches RFC 7748 section 5.2", () => {
  assert.equal(
    toHex(
      scalarMult(
        fromHex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"),
        fromHex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"),
      ),
    ),
    "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
  );
  assert.equal(
    toHex(
      scalarMult(
        fromHex("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d"),
        fromHex("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493"),
      ),
    ),
    "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
  );
});

test("X25519 Alice/Bob agreement matches RFC 7748 section 6.1", () => {
  const alicePriv = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const bobPriv = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  const alicePub = scalarMultBase(alicePriv);
  const bobPub = scalarMultBase(bobPriv);
  assert.equal(toHex(alicePub), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  assert.equal(toHex(bobPub), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");

  const shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
  assert.equal(toHex(scalarMult(alicePriv, bobPub)), shared);
  assert.equal(toHex(scalarMult(bobPriv, alicePub)), shared);
});

test("X25519 agreement works through the runtime-selected backend", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const ab = await agree(a.privateKey, b.publicKey);
  const ba = await agree(b.privateKey, a.publicKey);
  assert.deepEqual(ab, ba);
  assert.equal(ab.length, 32);
});

test("X25519 refuses small-order public keys", async () => {
  const a = await generateKeyPair();
  await assert.rejects(() => agree(a.privateKey, new Uint8Array(32)), /small-order/);
});

test("equalCT compares without early exit", () => {
  assert.equal(equalCT(utf8("abc"), utf8("abc")), true);
  assert.equal(equalCT(utf8("abc"), utf8("abd")), false);
  assert.equal(equalCT(utf8("abc"), utf8("abcd")), false);
});

/**
 * AES-256-GCM against the vectors from the GCM specification (McGrew & Viega,
 * "The Galois/Counter Mode of Operation", test cases 13–16 — the AES-256 set,
 * the same vectors NIST's validation suite is built from).
 *
 * Every other primitive here is checked against an official vector, and until
 * now AES was the exception: the suite was only exercised by round-trip tests,
 * which pass just as happily against a wrong-but-consistent implementation.
 * A round trip proves the two halves agree with each other, not that either
 * agrees with the standard — and the standard is what the other end of a
 * conversation implements.
 *
 * This exercises the platform's WebCrypto through the suite's own seal/open,
 * so it is the shipped path being checked, not a parallel one.
 */
test("AES-256-GCM matches the GCM specification vectors", async () => {
  const cases = [
    {
      name: "case 13 — empty plaintext, empty AAD",
      key: "00".repeat(32),
      nonce: "00".repeat(12),
      plaintext: "",
      aad: "",
      expected: "530f8afbc74536b9a963b4f1c4cb738b",
    },
    {
      name: "case 14 — one zero block",
      key: "00".repeat(32),
      nonce: "00".repeat(12),
      plaintext: "00".repeat(16),
      aad: "",
      expected: "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919",
    },
    {
      name: "case 15 — four blocks, no AAD",
      key: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
      nonce: "cafebabefacedbaddecaf888",
      plaintext:
        "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72" +
        "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255",
      aad: "",
      expected:
        "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa" +
        "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad" +
        "b094dac5d93471bdec1a502270e3cc6c",
    },
    {
      name: "case 16 — partial final block, with AAD",
      key: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
      nonce: "cafebabefacedbaddecaf888",
      plaintext:
        "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72" +
        "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
      aad: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
      expected:
        "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa" +
        "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" +
        "76fc6ece0f4e1768cddf8853bb2d551b",
    },
  ];

  for (const c of cases) {
    const sealed = await AesGcmSuite.seal(
      fromHex(c.key),
      fromHex(c.nonce),
      fromHex(c.plaintext),
      fromHex(c.aad),
    );
    assert.equal(toHex(sealed), c.expected, c.name);

    // And back, through the same suite: the tag must verify.
    const opened = await AesGcmSuite.open(
      fromHex(c.key),
      fromHex(c.nonce),
      sealed,
      fromHex(c.aad),
    );
    assert.equal(toHex(opened), c.plaintext, `${c.name} (round trip)`);
  }
});

test("AES-256-GCM rejects a tampered tag and mismatched AAD", async () => {
  const key = fromHex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308");
  const nonce = fromHex("cafebabefacedbaddecaf888");
  const aad = utf8("channel-42");
  const sealed = await AesGcmSuite.seal(key, nonce, utf8("attack at dawn"), aad);

  const flipped = Uint8Array.from(sealed);
  flipped[flipped.length - 1] ^= 0x01;
  await assert.rejects(() => AesGcmSuite.open(key, nonce, flipped, aad), /authentication failed/);

  // Same ciphertext, different associated data: this is what stops a message
  // being replayed into another channel.
  await assert.rejects(
    () => AesGcmSuite.open(key, nonce, sealed, utf8("channel-43")),
    /authentication failed/,
  );
});
