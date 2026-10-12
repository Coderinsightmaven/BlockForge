import { ScopeType } from "@blockforge/contracts";
import { integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { bytea, enumCheck, tsz } from "./_helpers.js";

/** AES-256-GCM encrypted values (secrets/service.ts). Never returned by the API. */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey(),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    name: text("name").notNull(),
    /** Ciphertext followed by the 16-byte GCM tag. */
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: tsz("created_at").notNull().defaultNow(),
    rotatedAt: tsz("rotated_at"),
  },
  (t) => [
    unique("secrets_scope_name_unique").on(t.scopeType, t.scopeId, t.name).nullsNotDistinct(),
    enumCheck("secrets_scope_type_check", t.scopeType, ScopeType.options),
  ],
);
