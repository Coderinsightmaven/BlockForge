import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { servers, serverVariables, templateVariables } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";

/** Values shorter than this are not masked (too likely to hit ordinary output). */
export const MIN_MASKED_LENGTH = 4;
export const MASK = "••••••";
const MAX_CACHED = 10_000;

/**
 * Concrete values of a server's non-user-viewable egg variables (passwords, tokens), which install
 * scripts and server processes may print (`echo "$DATABASE_PASSWORD"`). Every console/install line
 * is masked with them before any sink sees it: console ring buffer, `console:` topic, job logs.
 * Cached per server (bounded, TTL); variable/template changes invalidate.
 */
export class ConsoleSecretMasks {
  private readonly cache = new Map<string, { values: string[]; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ttlMs = 30_000,
  ) {}

  async forServer(serverId: string): Promise<string[]> {
    const hit = this.cache.get(serverId);
    if (hit && this.clock.now() - hit.at < this.ttlMs) return hit.values;
    const rows = await this.db
      .select({ defaultValue: templateVariables.defaultValue, value: serverVariables.value })
      .from(servers)
      .innerJoin(templateVariables, eq(templateVariables.templateId, servers.templateId))
      .leftJoin(serverVariables, and(eq(serverVariables.serverId, servers.id), eq(serverVariables.envName, templateVariables.envName)))
      .where(and(eq(servers.id, serverId), eq(templateVariables.userViewable, false)));
    const values = new Set<string>();
    for (const r of rows) {
      const v = r.value ?? r.defaultValue;
      if (v.length < MIN_MASKED_LENGTH) continue;
      values.add(v);
      values.add(Buffer.from(v, "utf8").toString("base64").replace(/=+$/, ""));
    }
    const list = [...values].sort((a, b) => b.length - a.length);
    if (this.cache.size >= MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(serverId, { values: list, at: this.clock.now() });
    return list;
  }

  invalidate(serverId?: string): void {
    if (serverId === undefined) this.cache.clear();
    else this.cache.delete(serverId);
  }
}

/** Replaces every occurrence of every value (longest first) with {@link MASK}. */
export function maskSecrets(line: string, values: readonly string[]): string {
  let out = line;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(MASK);
  return out;
}
