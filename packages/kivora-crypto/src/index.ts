/**
 * @kivora/crypto — the cryptographic core of the Kivora messenger.
 *
 * Nothing in this package talks to the network or to storage. It turns
 * plaintext into an envelope and back, and it is the only place in the client
 * that ever sees a private key.
 *
 * Importing this module registers the two built-in suites. To add your own,
 * import it and call `registerSuite` — see docs/CRYPTO.md.
 */

export * from "./bytes.ts";
export * from "./suite.ts";
export * from "./envelope.ts";
export * from "./identity.ts";
export * from "./safety.ts";
export * from "./files.ts";
export * from "./payload.ts";
export { TrustStore, type TrustState, type TrustRecord } from "./trust.ts";

export { sha256, hmacSha256, hkdf } from "./sha256.ts";
export * as x25519 from "./x25519.ts";
export * as ed25519 from "./ed25519.ts";
export * as chacha from "./chacha20poly1305.ts";

import { registerSuite } from "./suite.ts";
import { XChaCha20Suite } from "./suites/xchacha.ts";
import { AesGcmSuite } from "./suites/aesgcm.ts";

registerSuite(XChaCha20Suite, { preferredSuite: true });
registerSuite(AesGcmSuite);

export { XChaCha20Suite, AesGcmSuite };
