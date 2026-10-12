import { REDACTED } from "@blockforge/contracts";

/** Keys whose values are always replaced, at any depth. */
const SECRET_KEY_RE =
  /(pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|webhook[-_]?url|^url$|signature|^proof$|^otp|totp|seed)/i;
/** Values that look like BlockForge secrets even when stored under an innocuous key. */
const SECRET_VALUE_RE =
  /(bfe_[0-9a-f]{16}_[A-Za-z0-9_-]{43}|BFAgent\s+[A-Za-z0-9_.-]+|https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+)/g;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function redactString(value: string): string {
  return value.replace(SECRET_VALUE_RE, REDACTED);
}

/** Deep copy with secret-looking keys and values redacted. Used for audit details, job input and logs. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 32) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const keep = v === null || v === undefined || typeof v === "boolean";
    out[k] = isSecretKey(k) && !keep ? REDACTED : redactDeep(v, depth + 1);
  }
  return out;
}
