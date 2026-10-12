import { randomUUID } from "node:crypto";
import pg from "pg";
import { TEST_DATABASE_URL } from "./env.js";

let shared: pg.Pool | null = null;

export function testPool(): pg.Pool {
  shared ??= new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10 });
  return shared;
}

export async function closeTestPool(): Promise<void> {
  if (shared) await shared.end();
  shared = null;
}

/** Empties every application table (migrations and pg-boss state are kept). */
export async function truncateAll(pool: pg.Pool = testPool()): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  if (rows.length === 0) return;
  await pool.query(`TRUNCATE ${rows.map((r) => `"public"."${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

/** Inserts a minimal server row (servers are created by Phase 3 jobs; tests need them for scopes/telemetry). */
export async function insertServer(pool: pg.Pool, nodeId: string, opts: { name?: string; id?: string } = {}): Promise<string> {
  const id = opts.id ?? randomUUID();
  const name = opts.name ?? `srv-${id.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO servers (id, name, slug, kind, node_id, software, minecraft_version, state, desired_state, memory_limit_bytes, heap_max_bytes, port, restart_policy)
     VALUES ($1, $2, $3, 'game', $4, 'paper', '1.21.8', 'running', 'running', 4294967296, 3221225472, 25565, '{"mode":"on-failure","maxRetries":3,"backoffMs":10000}')`,
    [id, name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), nodeId],
  );
  return id;
}

/** Inserts a node row directly (for RBAC tests that do not need a live agent). */
export async function insertNode(pool: pg.Pool, opts: { name?: string; status?: string } = {}): Promise<string> {
  const id = randomUUID();
  const name = opts.name ?? `node-${id.slice(0, 8)}`;
  await pool.query(`INSERT INTO nodes (id, name, slug, status) VALUES ($1, $2, $3, $4)`, [id, name, name, opts.status ?? "active"]);
  return id;
}
