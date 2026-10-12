import { randomUUID } from "node:crypto";
import type { SshKey } from "@blockforge/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { userSshKeys } from "../db/schema/index.js";
import { sha256 } from "../lib/crypto.js";
import { badRequest, conflict, notFound, validationDetails } from "../lib/errors.js";

export class SshKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshKeyError";
  }
}

export interface ParsedSshKey {
  keyType: string;
  /** Normalised `<type> <base64>` (comment and options stripped). */
  publicKey: string;
  /** OpenSSH `SHA256:<base64 without padding>`. */
  fingerprint: string;
  bits: number;
}

const MIN_RSA_BITS = 3072;
const ECDSA_CURVES: Record<string, { curve: string; pointBytes: number; bits: number }> = {
  "ecdsa-sha2-nistp256": { curve: "nistp256", pointBytes: 65, bits: 256 },
  "ecdsa-sha2-nistp384": { curve: "nistp384", pointBytes: 97, bits: 384 },
  "ecdsa-sha2-nistp521": { curve: "nistp521", pointBytes: 133, bits: 521 },
};

/** Reads SSH wire-format strings (uint32 length + bytes). */
class WireReader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}
  string(): Buffer {
    if (this.off + 4 > this.buf.length) throw new SshKeyError("truncated key");
    const len = this.buf.readUInt32BE(this.off);
    this.off += 4;
    if (len > this.buf.length - this.off) throw new SshKeyError("truncated key");
    const out = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return out;
  }
  get done(): boolean {
    return this.off === this.buf.length;
  }
}

function bitLength(mpint: Buffer): number {
  let i = 0;
  while (i < mpint.length && mpint[i] === 0) i++;
  if (i === mpint.length) return 0;
  return (mpint.length - i - 1) * 8 + (32 - Math.clz32(mpint[i]!));
}

/** Fingerprint of a key blob as printed by `ssh-keygen -lf` (SHA256, unpadded base64). */
export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${sha256(blob).toString("base64").replace(/=+$/, "")}`;
}

/**
 * Parses an authorized_keys-style line. Accepted: ssh-ed25519, ecdsa-sha2-nistp256/384/521 and
 * ssh-rsa with ≥ 3072-bit moduli. DSA, short RSA, certificates and security-key types are refused.
 */
export function parseAuthorizedKey(line: string): ParsedSshKey {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) throw new SshKeyError("expected '<type> <base64-key> [comment]'");
  const [type, b64] = parts as [string, string];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new SshKeyError("the key is not valid base64");
  const blob = Buffer.from(b64, "base64");
  const r = new WireReader(blob);
  const inner = r.string().toString("ascii");
  if (inner !== type) throw new SshKeyError("the key type does not match its encoded type");
  let bits: number;
  if (type === "ssh-ed25519") {
    if (r.string().length !== 32) throw new SshKeyError("invalid Ed25519 key");
    bits = 256;
  } else if (type in ECDSA_CURVES) {
    const spec = ECDSA_CURVES[type]!;
    if (r.string().toString("ascii") !== spec.curve) throw new SshKeyError("ECDSA curve mismatch");
    const q = r.string();
    if (q.length !== spec.pointBytes || q[0] !== 0x04) throw new SshKeyError("invalid ECDSA public point");
    bits = spec.bits;
  } else if (type === "ssh-rsa") {
    const e = r.string();
    const n = r.string();
    if (bitLength(e) === 0) throw new SshKeyError("invalid RSA exponent");
    bits = bitLength(n);
    if (bits < MIN_RSA_BITS) throw new SshKeyError(`RSA keys must have at least ${MIN_RSA_BITS} bits (got ${bits})`);
  } else {
    throw new SshKeyError(`unsupported key type ${type.slice(0, 40)} (use ed25519, ECDSA or RSA ≥ ${MIN_RSA_BITS} bits)`);
  }
  if (!r.done) throw new SshKeyError("trailing data in key");
  return { keyType: type, publicKey: `${type} ${blob.toString("base64")}`, fingerprint: sshFingerprint(blob), bits };
}

export class SshKeysService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private dto(r: typeof userSshKeys.$inferSelect): SshKey {
    return { id: r.id, name: r.name, keyType: r.keyType, fingerprint: r.fingerprint, createdAt: r.createdAt.getTime(), lastUsedAt: r.lastUsedAt?.getTime() ?? null };
  }

  async list(userId: string): Promise<SshKey[]> {
    const rows = await this.db.select().from(userSshKeys).where(eq(userSshKeys.userId, userId)).orderBy(asc(userSshKeys.createdAt));
    return rows.map((r) => this.dto(r));
  }

  async add(userId: string, input: { name: string; publicKey: string }, actor: AuditActor): Promise<SshKey> {
    let parsed: ParsedSshKey;
    try {
      parsed = parseAuthorizedKey(input.publicKey);
    } catch (err) {
      if (err instanceof SshKeyError) throw badRequest(err.message, validationDetails(err.message, "publicKey"));
      throw err;
    }
    const [row] = await this.db
      .insert(userSshKeys)
      .values({ id: randomUUID(), userId, name: input.name, keyType: parsed.keyType, publicKey: parsed.publicKey, fingerprint: parsed.fingerprint })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict("This key is already on your account");
    await this.audit.record({ ...actor, action: "account.ssh_key.add", targetType: "user", targetId: userId, outcome: "success", details: { name: input.name, keyType: parsed.keyType, fingerprint: parsed.fingerprint } });
    return this.dto(row);
  }

  async remove(userId: string, id: string, actor: AuditActor): Promise<void> {
    const deleted = await this.db.delete(userSshKeys).where(and(eq(userSshKeys.id, id), eq(userSshKeys.userId, userId))).returning();
    if (!deleted.length) throw notFound("SSH key");
    await this.audit.record({ ...actor, action: "account.ssh_key.remove", targetType: "user", targetId: userId, outcome: "success", details: { fingerprint: deleted[0]!.fingerprint } });
  }
}
