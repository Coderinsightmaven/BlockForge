import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Strict base64url (no padding) decode; returns null on malformed input. */
export function fromB64url(value: string): Buffer | null {
  if (!B64URL_RE.test(value) || value.length % 4 === 1) return null;
  return Buffer.from(value, "base64url");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

export function hmacSha256(key: Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** Random opaque token, base64url encoded. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/** Constant-time string comparison (inputs are hashed first so differing lengths do not leak timing). */
export function safeEqual(a: string, b: string): boolean {
  const equalDigests = timingSafeEqual(sha256(a), sha256(b));
  return equalDigests && a.length === b.length;
}

/** Domain-separated subkey derivation from the master key (HKDF-SHA256). */
export function deriveKey(masterKey: Uint8Array, purpose: string, length = 32): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), `blockforge:${purpose}`, length));
}

// --- Ed25519 -----------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Raw 32-byte Ed25519 public key (base64url) → KeyObject. Returns null when malformed. */
export function ed25519PublicKeyFromRaw(publicKeyB64u: string): KeyObject | null {
  const raw = fromB64url(publicKeyB64u);
  if (!raw || raw.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

export function ed25519PrivateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** Extracts the 32-byte seed from an Ed25519 private KeyObject. */
export function ed25519SeedFromPrivateKey(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "pkcs8" });
  return Buffer.from(der.subarray(der.length - 32));
}

export function ed25519RawPublicKey(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  const der = pub.export({ format: "der", type: "spki" });
  return b64url(der.subarray(der.length - 32));
}

export function ed25519Sign(privateKey: KeyObject, message: Uint8Array): string {
  return b64url(cryptoSign(null, message, privateKey));
}

export function ed25519Verify(publicKey: KeyObject, message: Uint8Array, signatureB64u: string): boolean {
  const sig = fromB64url(signatureB64u);
  if (!sig || sig.length !== 64) return false;
  try {
    return cryptoVerify(null, message, publicKey, sig);
  } catch {
    return false;
  }
}
