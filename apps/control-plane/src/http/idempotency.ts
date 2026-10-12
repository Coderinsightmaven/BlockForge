import { IDEMPOTENCY_HEADER } from "@blockforge/contracts";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
import { canonicalJson, toJsonSafe } from "../lib/canonical-json.js";
import type { Clock } from "../lib/clock.js";
import { sha256Hex } from "../lib/crypto.js";
import { badRequest, conflict, unauthenticated } from "../lib/errors.js";

const KEY_RE = /^[\x21-\x7e]{1,128}$/;
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;
/** A placeholder row older than this is treated as abandoned (crash mid-request). */
const STALE_IN_PROGRESS_MS = 5 * 60_000;

export interface HandlerResult {
  status: number;
  body: unknown;
}

/**
 * `Idempotency-Key` support (api.md): keys are scoped to (user, route). The first request inserts a
 * placeholder row, runs, then stores status + body; a repeat with the same request hash replays the
 * stored response, a different body, path or query yields 409, and a concurrent duplicate while the first is still
 * running yields 409 as well. Failed requests (exceptions) release the key so clients can retry.
 */
export class IdempotencyService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async handle(req: FastifyRequest, reply: FastifyReply, route: string, handler: () => Promise<HandlerResult>): Promise<FastifyReply> {
    const header = req.headers[IDEMPOTENCY_HEADER];
    const key = Array.isArray(header) ? header[0] : header;
    if (key === undefined) return this.send(reply, await handler(), false);
    if (!KEY_RE.test(key)) throw badRequest("Idempotency-Key must be 1–128 printable ASCII characters");
    // Keys are scoped to the user behind the request (session user or API key owner).
    const userId = req.session?.user.id ?? req.principal?.userId;
    if (!userId) throw unauthenticated();
    // The query is part of the request (e.g. DELETE …?deleteData=true): a different query under the
    // same key must not replay the other response. Canonical JSON sorts keys; omitted when empty.
    const query = (req.query ?? {}) as Record<string, unknown>;
    const requestHash = sha256Hex(
      canonicalJson(toJsonSafe({ params: req.params ?? null, body: req.body ?? null, ...(Object.keys(query).length ? { query } : {}) })),
    );
    const pk = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.route, route), eq(idempotencyKeys.key, key));

    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await this.db
        .insert(idempotencyKeys)
        .values({ key, userId, route, requestHash, createdAt: new Date(this.clock.now()) })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });
      if (inserted.length) {
        let result: HandlerResult;
        try {
          result = await handler();
        } catch (err) {
          await this.db.delete(idempotencyKeys).where(pk);
          throw err;
        }
        const body = result.body === undefined ? null : toJsonSafe(result.body);
        await this.db.update(idempotencyKeys).set({ responseStatus: result.status, responseBody: body }).where(pk);
        return this.send(reply, result, false);
      }
      const [existing] = await this.db.select().from(idempotencyKeys).where(pk).limit(1);
      if (!existing) continue;
      if (existing.requestHash !== requestHash) throw conflict("This Idempotency-Key was already used for a different request", { reason: "key_reused" });
      if (existing.responseStatus === null) {
        if (this.clock.now() - existing.createdAt.getTime() > STALE_IN_PROGRESS_MS) {
          await this.db.delete(idempotencyKeys).where(and(pk, eq(idempotencyKeys.requestHash, requestHash)));
          continue;
        }
        throw conflict("A request with this Idempotency-Key is still being processed", { reason: "in_progress" });
      }
      return this.send(reply, { status: existing.responseStatus, body: existing.responseBody }, true);
    }
    throw conflict("Could not acquire the Idempotency-Key; retry the request");
  }

  private send(reply: FastifyReply, result: HandlerResult, replayed: boolean): FastifyReply {
    if (replayed) reply.header("idempotent-replayed", "true");
    reply.status(result.status);
    return result.status === 204 || result.body === null || result.body === undefined ? reply.send() : reply.send(result.body);
  }

  async prune(): Promise<void> {
    await this.db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(this.clock.now() - IDEMPOTENCY_RETENTION_MS)));
  }
}
