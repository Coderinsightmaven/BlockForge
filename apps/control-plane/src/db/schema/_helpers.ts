import { sql } from "drizzle-orm";
import { check, customType, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";

/** Case-insensitive text (the `citext` extension is created by the first migration). */
export const citext = customType<{ data: string }>({ dataType: () => "citext" });

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value)),
});

/** `timestamptz` mapped to JS `Date`. */
export const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const quote = (v: string) => `'${v.replaceAll("'", "''")}'`;

/**
 * Enums are `text` + CHECK constraints (data-model.md); the allowed values come from
 * `@blockforge/contracts` wherever the contracts define them.
 */
export function enumCheck(name: string, column: AnyPgColumn, values: readonly string[]) {
  return check(name, sql`${column} IN (${sql.raw(values.map(quote).join(", "))})`);
}

export function nullableEnumCheck(name: string, column: AnyPgColumn, values: readonly string[]) {
  return check(name, sql`${column} IS NULL OR ${column} IN (${sql.raw(values.map(quote).join(", "))})`);
}
