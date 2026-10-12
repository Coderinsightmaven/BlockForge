/**
 * Forwarding secrets. Generated with Web Crypto (`crypto.getRandomValues`, available in Node ≥ 19
 * and browsers) and encoded base64url without padding, so the value is printable, has no
 * whitespace and survives Velocity's `String.join("", Files.readAllLines(path))` read and YAML/TOML
 * quoting unchanged.
 */

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/** 32 random bytes (256 bits) → 43-character base64url string. */
export function generateForwardingSecret(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 32 || byteLength > 1024) throw new RangeError("secret length must be 32–1024 bytes");
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface SecretAssessment {
  present: boolean;
  /** UTF-8 length in bytes. */
  byteLength: number;
  /** Upper-bound estimate: length × log2(character pool), zeroed for repetitive strings. */
  estimatedEntropyBits: number;
  strong: boolean;
  problems: string[];
}

export const MIN_SECRET_ENTROPY_BITS = 256;

/**
 * Heuristic strength check (the secret itself is never stored in the result, so the assessment
 * can be passed to validators, logs and API responses).
 */
export function assessSecret(secret: string | null | undefined): SecretAssessment {
  if (!secret) return { present: false, byteLength: 0, estimatedEntropyBits: 0, strong: false, problems: ["No forwarding secret is configured."] };
  const problems: string[] = [];
  const byteLength = new TextEncoder().encode(secret).length;
  if (/[\r\n]/.test(secret)) problems.push("Secret contains line breaks; Velocity joins lines when reading the secret file, so it would differ from the backend copy.");
  if (secret !== secret.trim()) problems.push("Secret has leading or trailing whitespace, which is easy to lose when copying it into backend configs.");
  let pool = 0;
  if (/[a-z]/.test(secret)) pool += 26;
  if (/[A-Z]/.test(secret)) pool += 26;
  if (/[0-9]/.test(secret)) pool += 10;
  if (/[^A-Za-z0-9]/.test(secret)) pool += 33;
  // Strings over the base64url alphabet are credited the full 64-symbol pool, so a random
  // 43-character secret that happens to lack digits or '-'/'_' is not misjudged.
  if (/^[A-Za-z0-9_-]+$/.test(secret)) pool = 64;
  const counts = new Map<string, number>();
  for (const ch of secret) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const len = [...secret].length;
  let shannon = 0;
  for (const n of counts.values()) shannon -= (n / len) * Math.log2(n / len);
  // Strings dominated by few symbols (e.g. "aaaa…", "abababab…") get no credit.
  const repetitive = len >= 8 && (shannon < 3 || counts.size < Math.min(16, len / 2));
  const estimatedEntropyBits = repetitive ? Math.round(shannon * len) : Math.floor(len * Math.log2(Math.max(pool, 2)));
  if (repetitive) problems.push("Secret is highly repetitive.");
  if (estimatedEntropyBits < MIN_SECRET_ENTROPY_BITS) {
    problems.push(`Secret has an estimated ${estimatedEntropyBits} bits of entropy; use at least 256 bits (32 random bytes, e.g. BlockForge's generated 43-character secret).`);
  }
  return { present: true, byteLength, estimatedEntropyBits, strong: problems.length === 0, problems };
}

/** Content of Velocity's `forwarding-secret-file` (no trailing newline; Velocity ignores it anyway). */
export function forwardingSecretFileContent(secret: string): string {
  if (secret.length === 0 || /[\r\n]/.test(secret)) throw new RangeError("forwarding secret must be a non-empty single line");
  return secret;
}
