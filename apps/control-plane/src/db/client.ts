import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A transaction handle (same query API as `Db`). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export function createPool(databaseUrl: string, max = 20): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max,
    application_name: "blockforge-control-plane",
    // Fail fast instead of hanging forever when the database is unreachable.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

export { schema };
