/**
 * Deterministic JSON: object keys sorted recursively, no whitespace. Used for the audit hash chain
 * and idempotency request hashes, so values must round-trip through Postgres `jsonb` unchanged —
 * callers pass JSON-safe data only (see `toJsonSafe`).
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Converts a value into plain JSON data: Dates → epoch ms, bigint → string, drops undefined/functions. */
export function toJsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[too deep]";
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  switch (typeof value) {
    case "string":
      // jsonb rejects NUL characters.
      return value.includes("\u0000") ? value.replaceAll("\u0000", "�") : value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "object": {
      if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth + 1) ?? null);
      if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const safe = toJsonSafe(v, depth + 1);
        if (safe !== undefined) out[k] = safe;
      }
      return out;
    }
    default:
      return undefined;
  }
}
