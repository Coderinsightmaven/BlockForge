import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deriveKey, fromB64url, b64url } from "../lib/crypto.js";

export const CURRENT_KEY_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedValue {
  /** Ciphertext with the 16-byte GCM tag appended. */
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export class DecryptionError extends Error {
  constructor(message = "secret could not be decrypted") {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * AES-256-GCM with keys derived (HKDF) from the master key. Every value is bound to an AAD
 * string (e.g. `secret:<id>`, `user-mfa:<userId>`) so ciphertexts cannot be swapped between rows.
 * Key versions allow future master-key rotation: old versions stay decryptable while new writes
 * use `CURRENT_KEY_VERSION`.
 */
export class SecretBox {
  private readonly keys = new Map<number, Buffer>();
  readonly currentVersion: number;

  /**
   * @param masterKey     the current master key (writes use it)
   * @param opts.currentVersion version number of the current key (bumped on master-key rotation)
   * @param opts.previous older master keys by version, kept so existing rows stay readable
   */
  constructor(masterKey: Buffer, opts: { currentVersion?: number; previous?: ReadonlyMap<number, Buffer> } = {}) {
    if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
    this.currentVersion = opts.currentVersion ?? CURRENT_KEY_VERSION;
    for (const [version, key] of opts.previous ?? []) this.keys.set(version, deriveKey(key, `secrets-v${version}`));
    this.keys.set(this.currentVersion, deriveKey(masterKey, `secrets-v${this.currentVersion}`));
  }

  encrypt(plaintext: string | Buffer, aad: string): EncryptedValue {
    const key = this.keys.get(this.currentVersion);
    if (!key) throw new Error("current key missing");
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final()]);
    return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce, keyVersion: this.currentVersion };
  }

  decrypt(value: EncryptedValue, aad: string): Buffer {
    const key = this.keys.get(value.keyVersion);
    if (!key) throw new DecryptionError(`unknown key version ${value.keyVersion}`);
    if (value.nonce.length !== NONCE_BYTES || value.ciphertext.length < TAG_BYTES) throw new DecryptionError();
    const tag = value.ciphertext.subarray(value.ciphertext.length - TAG_BYTES);
    const body = value.ciphertext.subarray(0, value.ciphertext.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, value.nonce);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new DecryptionError();
    }
  }

  /** Compact single-column encoding: `v<version>.<nonce>.<ciphertext+tag>` (base64url). */
  encryptToString(plaintext: string, aad: string): string {
    const v = this.encrypt(plaintext, aad);
    return `v${v.keyVersion}.${b64url(v.nonce)}.${b64url(v.ciphertext)}`;
  }

  decryptString(encoded: string, aad: string): string {
    const m = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(encoded);
    if (!m) throw new DecryptionError("malformed encrypted value");
    const nonce = fromB64url(m[2] ?? "");
    const ciphertext = fromB64url(m[3] ?? "");
    if (!nonce || !ciphertext) throw new DecryptionError("malformed encrypted value");
    return this.decrypt({ ciphertext, nonce, keyVersion: Number(m[1]) }, aad).toString("utf8");
  }
}
