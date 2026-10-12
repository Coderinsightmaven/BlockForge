import type { AuditEvent, AuditVerifyResult } from "@blockforge/contracts";
import { and, asc, desc, eq, gt, gte, like, lt, lte, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.js";
import { auditEvents } from "../db/schema/index.js";
import { toJsonSafe } from "../lib/canonical-json.js";
import type { Clock } from "../lib/clock.js";
import { redactDeep } from "../lib/redact.js";
import { computeAuditHash, GENESIS_HASH, verifyChainBatch, type ChainRow } from "./chain.js";

export type AuditActorType = AuditEvent["actorType"];
export type AuditOutcome = AuditEvent["outcome"];

export interface AuditActor {
  actorType: AuditActorType;
  actorId: string | null;
  actorName: string | null;
  ip?: string | null;
  requestId?: string | null;
  /** The human user behind the actor (the key owner for `api_token`); used for user foreign keys. */
  userId?: string | null;
}

/** User id for `created_by`/`requested_by`-style columns (never an API key id). */
export function actorUserId(actor: AuditActor): string | null {
  if (actor.userId !== undefined) return actor.userId;
  return actor.actorType === "user" ? actor.actorId : null;
}

export interface AuditEntry extends AuditActor {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome: AuditOutcome;
  details?: Record<string, unknown>;
}

export const SYSTEM_ACTOR: AuditActor = { actorType: "system", actorId: null, actorName: "system" };

/** Serialises all audit writers (single-writer hash chain). */
const AUDIT_LOCK_KEY = 0x0b10a0d1;

export interface AuditListFilter {
  limit: number;
  beforeId?: number;
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  from?: number;
  to?: number;
}

/**
 * Insert-only, hash-chained audit log. Writes take a transaction-scoped advisory lock so the
 * chain stays linear even with concurrent writers (and multiple replicas). Details are redacted
 * before hashing/persisting, so secrets never enter the log.
 */
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Records an entry inside `tx` (atomic with the audited change) or in its own transaction. */
  async record(entry: AuditEntry, tx?: DbOrTx): Promise<void> {
    if (tx) return this.insert(entry, tx);
    await this.db.transaction(async (t) => this.insert(entry, t));
  }

  private async insert(entry: AuditEntry, tx: DbOrTx): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);
    const [last] = await tx.select({ hash: auditEvents.hash }).from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const at = this.clock.now();
    const details = toJsonSafe(redactDeep(entry.details ?? {})) as Record<string, unknown>;
    const fields = {
      at,
      actorType: entry.actorType,
      actorId: entry.actorId,
      actorName: entry.actorName,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ?? null,
      requestId: entry.requestId ?? null,
      outcome: entry.outcome,
      details,
    };
    const hash = computeAuditHash(prevHash, fields);
    await tx.insert(auditEvents).values({ ...fields, at: new Date(at), prevHash, hash });
  }

  async list(filter: AuditListFilter): Promise<{ items: AuditEvent[]; nextBeforeId: number | null }> {
    const conds: SQL[] = [];
    if (filter.beforeId !== undefined) conds.push(lt(auditEvents.id, filter.beforeId));
    if (filter.action) {
      conds.push(
        filter.action.endsWith("*")
          ? like(auditEvents.action, `${filter.action.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
          : eq(auditEvents.action, filter.action),
      );
    }
    if (filter.actorId) conds.push(eq(auditEvents.actorId, filter.actorId));
    if (filter.targetType) conds.push(eq(auditEvents.targetType, filter.targetType));
    if (filter.targetId) conds.push(eq(auditEvents.targetId, filter.targetId));
    if (filter.from !== undefined) conds.push(gte(auditEvents.at, new Date(filter.from)));
    if (filter.to !== undefined) conds.push(lte(auditEvents.at, new Date(filter.to)));
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditEvents.id))
      .limit(filter.limit + 1);
    const page = rows.slice(0, filter.limit);
    return {
      items: page.map((r) => ({
        id: String(r.id),
        at: r.at.getTime(),
        actorType: r.actorType as AuditActorType,
        actorId: r.actorId,
        actorName: r.actorName,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        outcome: r.outcome as AuditOutcome,
        ip: r.ip,
        requestId: r.requestId,
        details: (r.details ?? {}) as Record<string, unknown>,
      })),
      nextBeforeId: rows.length > filter.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Walks the whole chain in id order. */
  async verify(batchSize = 1000): Promise<AuditVerifyResult> {
    let prevHash = GENESIS_HASH;
    let lastId = 0;
    let checked = 0;
    for (;;) {
      const rows = await this.db
        .select()
        .from(auditEvents)
        .where(gt(auditEvents.id, lastId))
        .orderBy(asc(auditEvents.id))
        .limit(batchSize);
      if (rows.length === 0) return { valid: true, checked, firstBrokenId: null };
      const chainRows: ChainRow[] = rows.map((r) => ({
        id: r.id,
        at: r.at.getTime(),
        actorType: r.actorType,
        actorId: r.actorId,
        actorName: r.actorName,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        ip: r.ip,
        requestId: r.requestId,
        outcome: r.outcome,
        details: r.details,
        prevHash: r.prevHash,
        hash: r.hash,
      }));
      const result = verifyChainBatch(chainRows, prevHash);
      checked += result.checked;
      if (!result.valid) return { valid: false, checked, firstBrokenId: result.firstBrokenId ?? null };
      prevHash = result.lastHash;
      lastId = rows[rows.length - 1]?.id ?? lastId;
    }
  }
}
