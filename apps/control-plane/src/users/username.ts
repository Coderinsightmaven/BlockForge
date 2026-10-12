import { inArray, like, or } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { users } from "../db/schema/index.js";

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/**
 * Username derived from an email's local part: lowercase, invalid characters → "-", leading
 * separators removed, padded to 3 and truncated so a numeric suffix still fits in 32 characters.
 * Mirrors the backfill in migration 0001.
 */
export function usernameBase(email: string): string {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  let base = local.replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 28);
  if (base === "") base = "user";
  if (base.length < 3) base = base + "0".repeat(3 - base.length);
  return base;
}

/** First free username `base`, `base-2`, `base-3`, … (checked against the database). */
export async function uniqueUsername(tx: DbOrTx, email: string): Promise<string> {
  const base = usernameBase(email);
  const taken = new Set(
    (
      await tx
        .select({ u: users.username })
        .from(users)
        .where(or(inArray(users.username, [base]), like(users.username, `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}-%`)))
    ).map((r) => r.u),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
