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

/** Owner for directly inserted servers: the oldest user, or a placeholder account. */
async function anyUserId(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1");
  if (rows[0]) return rows[0].id;
  const id = randomUUID();
  await pool.query("INSERT INTO users (id, email, username, display_name, password_hash) VALUES ($1, $2, $3, 'Placeholder', 'x')", [
    id,
    `placeholder-${id.slice(0, 8)}@example.com`,
    `placeholder-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function templateId(pool: pg.Pool, key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM templates WHERE key = $1", [key]);
  if (rows[0]) return rows[0].id;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO templates (id, key, name, category, kind, game, source, stop, runtime)
     VALUES ($1, $2, 'Minecraft', 'Minecraft', 'minecraft', 'minecraft-java', 'builtin', '{"type":"command","command":"stop"}', '{"dataMountPath":"/data","readOnlyRootfs":true}')`,
    [id, key],
  );
  return id;
}

/** Inserts a minimal server row (tests that only need a server to exist for scopes/telemetry). */
export async function insertServer(
  pool: pg.Pool,
  nodeId: string,
  opts: { name?: string; id?: string; ownerId?: string; state?: string } = {},
): Promise<string> {
  const id = opts.id ?? randomUUID();
  const name = opts.name ?? `srv-${id.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO servers (id, name, slug, kind, owner_id, template_id, node_id, software, minecraft_version, state, desired_state, memory_limit_bytes, heap_max_bytes, docker_image, restart_policy)
     VALUES ($1, $2, $3, 'game', $4, $5, $6, 'paper', '1.21.8', $7, 'running', 4294967296, 3221225472, 'eclipse-temurin:21-jre', '{"mode":"on-failure","maxRetries":3,"backoffMs":10000}')`,
    [id, name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), opts.ownerId ?? (await anyUserId(pool)), await templateId(pool, "minecraft-java"), nodeId, opts.state ?? "running"],
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
