import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CURRENT_KEY_VERSION, DecryptionError, SecretBox } from "../../src/secrets/secret-box.js";

describe("SecretBox (AES-256-GCM)", () => {
  const box = new SecretBox(randomBytes(32));

  it("round-trips values with a fresh nonce each time", () => {
    const a = box.encrypt("https://discord.com/api/webhooks/1/secret", "secret:1");
    const b = box.encrypt("https://discord.com/api/webhooks/1/secret", "secret:1");
    expect(a.keyVersion).toBe(CURRENT_KEY_VERSION);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.toString("utf8")).not.toContain("secret");
    expect(box.decrypt(a, "secret:1").toString()).toBe("https://discord.com/api/webhooks/1/secret");
  });

  it("binds ciphertexts to their AAD (no swapping between rows)", () => {
    const v = box.encrypt("value", "secret:1");
    expect(() => box.decrypt(v, "secret:2")).toThrow(DecryptionError);
  });

  it("detects tampering", () => {
    const v = box.encrypt("value", "x");
    const tampered = Buffer.from(v.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => box.decrypt({ ...v, ciphertext: tampered }, "x")).toThrow(DecryptionError);
  });

  it("fails with another master key", () => {
    const v = box.encrypt("value", "x");
    expect(() => new SecretBox(randomBytes(32)).decrypt(v, "x")).toThrow(DecryptionError);
  });

  it("decrypts values written with a previous master key version after rotation", () => {
    const oldKey = randomBytes(32);
    const old = new SecretBox(oldKey).encrypt("legacy", "x");
    expect(old.keyVersion).toBe(1);
    const rotated = new SecretBox(randomBytes(32), { currentVersion: 2, previous: new Map([[1, oldKey]]) });
    expect(rotated.decrypt(old, "x").toString()).toBe("legacy");
    expect(rotated.encrypt("new", "x").keyVersion).toBe(2);
    expect(() => new SecretBox(randomBytes(32)).decrypt(old, "x")).toThrow(DecryptionError);
  });

  it("has a compact string encoding", () => {
    const s = box.encryptToString("JBSWY3DPEHPK3PXP", "user-mfa:u1");
    expect(s).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(s).not.toContain("JBSWY3DP");
    expect(box.decryptString(s, "user-mfa:u1")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => box.decryptString(s, "user-mfa:u2")).toThrow(DecryptionError);
    expect(() => box.decryptString("garbage", "x")).toThrow(DecryptionError);
  });
});
