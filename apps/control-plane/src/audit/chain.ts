import { canonicalJson } from "../lib/canonical-json.js";
import { sha256Hex } from "../lib/crypto.js";

export const GENESIS_HASH = "0".repeat(64);

/** The fields covered by the hash chain (everything except the bigserial id and the hashes). */
export interface AuditHashFields {
  at: number;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  requestId: string | null;
  outcome: string;
  details: unknown;
}

/** `hash = sha256(prev_hash ‖ canonical JSON of the row fields)`. */
export function computeAuditHash(prevHash: string, fields: AuditHashFields): string {
  const canonical = canonicalJson({
    at: fields.at,
    actorType: fields.actorType,
    actorId: fields.actorId,
    actorName: fields.actorName,
    action: fields.action,
    targetType: fields.targetType,
    targetId: fields.targetId,
    ip: fields.ip,
    requestId: fields.requestId,
    outcome: fields.outcome,
    details: fields.details,
  });
  return sha256Hex(prevHash + canonical);
}

export interface ChainRow extends AuditHashFields {
  id: number;
  prevHash: string;
  hash: string;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  firstBrokenId?: string;
  /** Hash of the last verified row; pass it back in to continue verification across batches. */
  lastHash: string;
}

/** Verifies a contiguous, id-ordered batch of rows starting after `prevHash`. */
export function verifyChainBatch(rows: readonly ChainRow[], prevHash: string): ChainVerification {
  let expectedPrev = prevHash;
  let checked = 0;
  for (const row of rows) {
    checked++;
    if (row.prevHash !== expectedPrev || computeAuditHash(row.prevHash, row) !== row.hash) {
      return { valid: false, checked, firstBrokenId: String(row.id), lastHash: expectedPrev };
    }
    expectedPrev = row.hash;
  }
  return { valid: true, checked, lastHash: expectedPrev };
}
