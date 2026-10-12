import pg from "pg";
import { pino } from "pino";
import { runMigrations } from "../../src/db/migrate.js";
import { TEST_DATABASE_URL, TEST_PGBOSS_SCHEMA } from "./env.js";

/** Recreates the test database schema once per `vitest run` and applies the checked-in migrations. */
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS public CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_PGBOSS_SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA public`);
    await runMigrations(pool, pino({ level: "silent" }));
  } catch (err) {
    throw new Error(
      `Cannot prepare the test database at ${TEST_DATABASE_URL} (is \`pnpm infra:up\` running?): ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    await pool.end();
  }
}
