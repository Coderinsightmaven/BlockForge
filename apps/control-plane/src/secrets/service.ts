import { randomUUID } from "node:crypto";
import type { ScopeType } from "@blockforge/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { secrets } from "../db/schema/index.js";
import type { SecretBox } from "./secret-box.js";

export interface SecretScope {
  scopeType: ScopeType;
  scopeId: string | null;
}

const aadFor = (id: string) => `secret:${id}`;

/**
 * Stores encrypted values in the `secrets` table. Plaintext only ever exists in memory for the
 * duration of a call; nothing here logs or returns ciphertext to API callers.
 */
export class SecretsService {
  constructor(
    private readonly db: DbOrTx,
    private readonly box: SecretBox,
  ) {}

  async create(scope: SecretScope, name: string, value: string, tx: DbOrTx = this.db): Promise<string> {
    const id = randomUUID();
    const enc = this.box.encrypt(value, aadFor(id));
    await tx.insert(secrets).values({
      id,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      name,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      keyVersion: enc.keyVersion,
    });
    return id;
  }

  /** Replaces the value of an existing secret (re-encrypted with a fresh nonce and current key). */
  async update(id: string, value: string, tx: DbOrTx = this.db): Promise<void> {
    const enc = this.box.encrypt(value, aadFor(id));
    await tx
      .update(secrets)
      .set({ ciphertext: enc.ciphertext, nonce: enc.nonce, keyVersion: enc.keyVersion, rotatedAt: new Date() })
      .where(eq(secrets.id, id));
  }

  async read(id: string, tx: DbOrTx = this.db): Promise<string | null> {
    const [row] = await tx.select().from(secrets).where(eq(secrets.id, id)).limit(1);
    if (!row) return null;
    return this.box.decrypt({ ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion }, aadFor(row.id)).toString("utf8");
  }

  async findIdByName(scope: SecretScope, name: string, tx: DbOrTx = this.db): Promise<string | null> {
    const [row] = await tx
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.scopeType, scope.scopeType),
          scope.scopeId === null ? isNull(secrets.scopeId) : eq(secrets.scopeId, scope.scopeId),
          eq(secrets.name, name),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  async delete(id: string, tx: DbOrTx = this.db): Promise<void> {
    await tx.delete(secrets).where(eq(secrets.id, id));
  }
}
