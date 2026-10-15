import { X509Certificate } from "node:crypto";
import { createServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { Writable } from "node:stream";
import type { TLSSocket } from "node:tls";
import { DatabaseHost, DatabaseHostTestResult, Server, ServerDatabase, ServerDatabasePassword } from "@blockforge/contracts";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging/logger.js";
import { createUserClient, responseLog, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import { TEST_DATABASE_URL, TEST_MARIADB, TEST_MYSQL } from "../support/env.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { catalogOptions, connectSimNode, paperRequest, poll, templateIdByKey, waitJob } from "../support/panel.js";

/**
 * Runs against the MariaDB 11.4 service of infra/compose (`pnpm infra:up`; required) and, when it answers, the
 * opt-in MySQL 8.4 service (`--profile mysql`; its tests are skipped otherwise). Every database and user the
 * tests create matches `s<8 hex>_…` / `u<8 hex>_…` and is dropped after each test.
 */
interface Target {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  version: RegExp;
}
const TARGETS: Target[] = [
  { name: "MariaDB 11.4", ...TEST_MARIADB, version: /MariaDB/ },
  { name: "MySQL 8.4", ...TEST_MYSQL, version: /^8\.4\./ },
];
const MARIADB = TARGETS[0]!;
const MYSQL = TARGETS[1]!;

/** A valid certificate of an unrelated CA (pinning it must make TLS verification fail). */
const UNRELATED_CA = `-----BEGIN CERTIFICATE-----
MIICzDCCAbQCCQCgGI8NQEliZjANBgkqhkiG9w0BAQsFADAnMSUwIwYDVQQDDBxi
bG9ja2ZvcmdlLXRlc3QtdW5yZWxhdGVkLWNhMCAXDTI2MTAxNTA0NTUxN1oYDzIx
MjYwOTIxMDQ1NTE3WjAnMSUwIwYDVQQDDBxibG9ja2ZvcmdlLXRlc3QtdW5yZWxh
dGVkLWNhMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3ygW5Jiytl8
a084MPHhs8QLqU+xVYP410qllAl2ADny011zqAP+/zIW63dcp+nBHsoyViwARbCh
zT1Fa2xOYQswF8kQyWQviRKfZ4BALns4ANst/yoCEkgXVc/s//wnj1jZMaa0PsNF
nnDHjPxDdLW0756DCpf/4/gmVAljLYe/dzcy7qUogU8wmFSWEZSpTuiIbH5DZPQY
oWk9E4o40aDPOapOfKj/QXNx9fkF7P9nHiVXfsPIdheC4rqRsCOj1RwPGY9jJ1JB
fwc1+j5Y46/rlweI+mqLPlTYU3nSwED18IhvZY07RPhBRJHDK5/gRyrC0ayBaQ5M
CzYH0zLsewIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQC0H2EzE3xhUrZSyw13DBvJ
iKZjBPuFR5Ecp4aJqZw7Ct3XI6qiMma91L6PjqacOI90SD+InmDwqpC7BtiobyJK
z4YeyT3R+/PqRXFjqVmI+ljlI2oQYIpZg/OkrW99pXVOvYLGui6yd2HD8MlCJ/ko
queFN5cQL4vQFOWpfMBHjIuL5PpddMugXTY3dojEMaZjA10XunMVrS5le6mSEYsz
dZW5Lkm0terWR7Y7eDVtFzCgKHDi+cGtH1cbGPry8pBb/KUiZQOOwfNscET8Va+C
kRm6Wha1gheTvFbjJlDfPiaUlZ8zQxvusoqJSBMAtJbFnUBbaiildrUkVFOnLB3Q
-----END CERTIFICATE-----`;

/** A database created directly as root that server databases must never reach. */
const FOREIGN_DB = "bf_wt_foreign_secret";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
let logLines: string[] = [];

async function root(target: Target) {
  return mysql.createConnection({ host: target.host, port: target.port, user: target.user, password: target.password, ssl: { rejectUnauthorized: false } });
}

/** The certificate the host presents (read over an unverified TLS session). */
async function serverCertificatePem(target: Target): Promise<string> {
  const c = await root(target);
  try {
    const stream = (c as unknown as { connection: { stream: TLSSocket } }).connection.stream;
    return new X509Certificate(stream.getPeerCertificate(true).raw).toString().trim();
  } finally {
    await c.end();
  }
}

const answers = (target: Target) =>
  root(target).then(
    async (c) => {
      await c.end();
      return true;
    },
    () => false,
  );
/** MySQL 8.4 is opt-in in the dev stack: its tests run only when it answers. MariaDB is required (no skip). */
const MYSQL_UP = await answers(MYSQL);
const UP = new Map<Target, boolean>([
  [MARIADB, await answers(MARIADB)],
  [MYSQL, MYSQL_UP],
]);

async function cleanTarget(target: Target): Promise<void> {
  if (!UP.get(target)) return;
  const c = await root(target);
  try {
    const [dbs] = await c.query("SELECT schema_name AS n FROM information_schema.schemata WHERE schema_name REGEXP '^s[0-9a-f]{8}_' OR schema_name = ?", [FOREIGN_DB]);
    for (const { n } of dbs as { n: string }[]) await c.query(`DROP DATABASE IF EXISTS \`${n}\``);
    const [users] = await c.query("SELECT user AS u, host AS h FROM mysql.user WHERE user REGEXP '^u[0-9a-f]{8}_[a-z0-9]{10}$'");
    for (const { u, h } of users as { u: string; h: string }[]) await c.query("DROP USER IF EXISTS ?@?", [u, h]);
  } finally {
    await c.end();
  }
}

/** TCP servers that accept connections and never answer (a hanging database host). */
const hangers: Hanger[] = [];
async function hangingHost(): Promise<{ port: number; open: () => number }> {
  const sockets = new Set<Socket>();
  const srv = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  hangers.push({ srv, sockets });
  return { port: (srv.address() as AddressInfo).port, open: () => sockets.size };
}
interface Hanger {
  srv: NetServer;
  sockets: Set<Socket>;
}

/** Dedicated Postgres connections of probing tests (outside the app's pool). */
const probes: pg.Client[] = [];

afterEach(async () => {
  for (const p of probes.splice(0)) await p.end().catch(() => undefined);
  for (const h of hangers.splice(0)) {
    for (const s of h.sockets) s.destroy();
    await new Promise((r) => h.srv.close(r));
  }
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
  for (const target of TARGETS) await cleanTarget(target);
});
afterAll(async () => {
  for (const target of TARGETS) await cleanTarget(target);
});

async function boot(databases: { connectTimeoutMs?: number; generateUsername?: (shortId: string) => string } = {}) {
  logLines = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  const cat = catalogOptions();
  const r = await startWithOwner({
    background: true,
    catalog: cat.catalog,
    serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0 },
    logger: createLogger("debug", {}, sink),
    databases: { connectTimeoutMs: 3000, queryTimeoutMs: 10_000, ...databases },
  });
  t = r.t;
  return r;
}

const hostBody = (target: Target, over: Record<string, unknown> = {}) => ({
  name: target.name,
  host: target.host,
  port: target.port,
  username: target.user,
  password: target.password,
  ...over,
});

async function createHost(owner: ApiClient, target: Target, over: Record<string, unknown> = {}): Promise<DatabaseHost> {
  const res = await owner.post("/database-hosts", hostBody(target, over));
  expect(res.statusCode, res.body).toBe(201);
  return DatabaseHost.parse(res.json());
}

async function paperServer(owner: ApiClient, over: Record<string, unknown> = {}): Promise<Server> {
  const templateId = await templateIdByKey(owner, "minecraft-java");
  const created = await owner.post("/servers", paperRequest(templateId, { startup: "manual", ...over }));
  expect(created.statusCode, created.body).toBe(202);
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  return Server.parse((await owner.get(`/servers/${created.json().server.id}`)).json());
}

const status = async (res: Promise<{ statusCode: number; json(): { error?: { code: string; details?: { reason?: string } } } }>) => {
  const r = await res;
  const e = r.json().error;
  return `${r.statusCode}${e ? ` ${e.code}` : ""}${e?.details?.reason ? ` ${e.details.reason}` : ""}`;
};

async function userId(c: ApiClient): Promise<string> {
  return (await c.get("/auth/me")).json().user.id as string;
}

/** Connects as a created database user (TLS without verification, like most game-server clients). */
async function asUser(target: Target, db: ServerDatabase, password: string) {
  return mysql.createConnection({ host: target.host, port: target.port, user: db.username, password, database: db.database, ssl: { rejectUnauthorized: false } });
}

async function connectError(target: Target, db: ServerDatabase, password: string): Promise<string | null> {
  try {
    const c = await asUser(target, db, password);
    await c.end();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "error";
  }
}

async function queryError(c: mysql.Connection, sql: string): Promise<string | null> {
  try {
    await c.query(sql);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "error";
  }
}

/** Every secret must be absent from responses (except the password route's own), the audit log, job data and logs. */
async function expectNoLeak(secrets: string[], allowResponseUrl: (url: string) => boolean = () => false): Promise<void> {
  const responses = responseLog.filter((r) => !allowResponseUrl(r.url));
  const { rows: audit } = await testPool().query<{ d: string }>("SELECT concat_ws(' ', action, actor_name, details::text) AS d FROM audit_events");
  const { rows: jobs } = await testPool().query<{ d: string }>("SELECT concat_ws(' ', input::text, result::text, error::text) AS d FROM jobs");
  const { rows: jobLogs } = await testPool().query<{ d: string }>("SELECT message AS d FROM job_logs");
  const { rows: events } = await testPool().query<{ d: string }>("SELECT data::text AS d FROM events");
  for (const s of secrets) {
    expect(responses.filter((r) => r.body.includes(s)).map((r) => r.url), "responses").toEqual([]);
    expect(audit.filter((r) => r.d.includes(s)), "audit").toEqual([]);
    expect(jobs.filter((r) => r.d?.includes(s)), "jobs").toEqual([]);
    expect(jobLogs.filter((r) => r.d.includes(s)), "job logs").toEqual([]);
    expect(events.filter((r) => r.d?.includes(s)), "events").toEqual([]);
    expect(logLines.filter((l) => l.includes(s)), "logs").toEqual([]);
  }
}

describe("database hosts (admin)", () => {
  it("CRUD with a write-only password, test connection over TLS modes, password re-entry and delete refusal", async () => {
    responseLog.length = 0;
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents });
    const adminPassword = MARIADB.password;

    // Create: the password is never returned (strict DTO), node link resolved.
    const host = await createHost(owner, MARIADB, { nodeId: node.nodeId, maxDatabases: 5, publicHost: "db.example.net", notes: "primary" });
    expect(host).toMatchObject({ name: MARIADB.name, host: MARIADB.host, port: MARIADB.port, username: "root", nodeId: node.nodeId, maxDatabases: 5, databaseCount: 0, tlsMode: "preferred", publicHost: "db.example.net" });
    expect(host.nodeName).toBeTruthy();
    expect(Object.keys(host)).not.toContain("password");
    expect((await owner.get("/database-hosts")).json()).toHaveLength(1);
    expect(DatabaseHost.parse((await owner.get(`/database-hosts/${host.id}`)).json()).id).toBe(host.id);
    expect(await status(owner.post("/database-hosts", hostBody(MARIADB)))).toBe("409 CONFLICT");
    expect(await status(owner.post("/database-hosts", hostBody(MARIADB, { name: "x", host: "mysql://db" })))).toBe("400 VALIDATION_FAILED");
    expect(await status(owner.post("/database-hosts", hostBody(MARIADB, { name: "x", tlsCaCertificate: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----" })))).toBe("400 VALIDATION_FAILED");

    // The ciphertext is bound to the row and is not the password.
    const { rows } = await testPool().query("SELECT password_enc FROM database_hosts WHERE id = $1", [host.id]);
    expect(rows[0].password_enc).toMatch(/^v\d+\./);
    expect(rows[0].password_enc).not.toContain(adminPassword);

    // Test connection: preferred (MariaDB 11.4 offers TLS), disabled, required (not verified), verify_ca.
    const tested = DatabaseHostTestResult.parse((await owner.post(`/database-hosts/${host.id}/test`)).json());
    expect(tested).toMatchObject({ ok: true, error: null, tls: true });
    expect(tested.serverVersion).toMatch(MARIADB.version);
    const unsaved = (over: Record<string, unknown>) => owner.post("/database-hosts/test", { host: MARIADB.host, port: MARIADB.port, username: "root", password: adminPassword, ...over });
    expect((await unsaved({ tlsMode: "disabled" })).json()).toMatchObject({ ok: true, tls: false });
    // `required` accepts any certificate (encrypted, host not verified) — even one no CA vouches for.
    expect((await unsaved({ tlsMode: "required" })).json()).toMatchObject({ ok: true, tls: true });
    const pinned = DatabaseHostTestResult.parse((await unsaved({ tlsMode: "verify_ca", tlsCaCertificate: UNRELATED_CA })).json());
    expect(pinned.ok).toBe(false);
    expect(pinned.error).toMatch(/^TLS error: /);
    // MariaDB 11.4 serves a self-signed certificate generated at start-up: pinning exactly it verifies.
    const own = await serverCertificatePem(MARIADB);
    expect((await unsaved({ tlsMode: "verify_ca", tlsCaCertificate: own })).json()).toMatchObject({ ok: true, tls: true });
    // The CA is accepted only with (and required by) verify_ca.
    expect(await status(unsaved({ tlsMode: "verify_ca" }))).toBe("400 VALIDATION_FAILED");
    expect(await status(unsaved({ tlsMode: "required", tlsCaCertificate: own }))).toBe("400 VALIDATION_FAILED");
    expect(await status(unsaved({ tlsMode: "preferred", tlsCaCertificate: own }))).toBe("400 VALIDATION_FAILED");
    expect(await status(owner.post("/database-hosts", hostBody(MARIADB, { name: "y", tlsMode: "required", tlsCaCertificate: own })))).toBe("400 VALIDATION_FAILED");
    expect(await status(owner.post("/database-hosts", hostBody(MARIADB, { name: "y", tlsMode: "verify_ca" })))).toBe("400 VALIDATION_FAILED");
    const wrong = DatabaseHostTestResult.parse((await unsaved({ password: "definitely-wrong-password-123" })).json());
    expect(wrong).toMatchObject({ ok: false, error: "access denied for the admin user (check the username and password)" });
    const refused = DatabaseHostTestResult.parse((await unsaved({ port: 1 })).json());
    expect(refused).toMatchObject({ ok: false, error: "connection refused" });

    // The stored password is reused only for the saved connection settings.
    expect((await owner.post("/database-hosts/test", { host: MARIADB.host, port: MARIADB.port, username: "root", hostId: host.id })).json()).toMatchObject({ ok: true });
    for (const change of [{ port: 1 }, { host: "localhost" }, { username: "other" }, { tlsMode: "disabled" }, { tlsMode: "verify_ca", tlsCaCertificate: UNRELATED_CA }]) {
      const body = { host: MARIADB.host, port: MARIADB.port, username: "root", hostId: host.id, ...change };
      const res = await owner.post("/database-hosts/test", body);
      expect(res.statusCode, JSON.stringify(change)).toBe(400);
      expect(res.json().error.details.issues[0].path).toBe("password");
      const patch = await owner.patch(`/database-hosts/${host.id}`, change);
      expect(patch.statusCode, JSON.stringify(change)).toBe(400);
      expect(patch.json().error.details.issues[0].path).toBe("password");
    }

    // Non-connection fields change without the password; a new password replaces the stored one.
    const renamed = await owner.patch(`/database-hosts/${host.id}`, { name: "Renamed", notes: "", maxDatabases: null, nodeId: null, publicHost: null });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(DatabaseHost.parse(renamed.json())).toMatchObject({ name: "Renamed", maxDatabases: null, nodeId: null, publicHost: null });
    expect((await owner.patch(`/database-hosts/${host.id}`, { password: "now-wrong-password-456" })).statusCode).toBe(200);
    expect((await owner.post(`/database-hosts/${host.id}/test`)).json()).toMatchObject({ ok: false });
    expect((await owner.patch(`/database-hosts/${host.id}`, { tlsMode: "required", password: adminPassword })).statusCode).toBe(200);
    expect((await owner.post(`/database-hosts/${host.id}/test`)).json()).toMatchObject({ ok: true, tls: true });
    // PATCH applies the CA rule to the resulting host; switching away from verify_ca clears the CA.
    const toVerify = await owner.patch(`/database-hosts/${host.id}`, { tlsMode: "verify_ca", password: adminPassword });
    expect(toVerify.statusCode).toBe(400);
    expect(toVerify.json().error.details.issues[0].path).toBe("tlsCaCertificate");
    expect(await status(owner.patch(`/database-hosts/${host.id}`, { tlsCaCertificate: own, password: adminPassword }))).toBe("400 VALIDATION_FAILED");
    const verified = await owner.patch(`/database-hosts/${host.id}`, { tlsMode: "verify_ca", tlsCaCertificate: own, password: adminPassword });
    expect(DatabaseHost.parse(verified.json())).toMatchObject({ tlsMode: "verify_ca", tlsCaCertificate: own });
    expect((await owner.post(`/database-hosts/${host.id}/test`)).json()).toMatchObject({ ok: true, tls: true });
    const back = await owner.patch(`/database-hosts/${host.id}`, { tlsMode: "required", password: adminPassword });
    expect(DatabaseHost.parse(back.json())).toMatchObject({ tlsMode: "required", tlsCaCertificate: null });

    // Only database_hosts.manage holders (global) reach these routes; the denial is audited.
    const serverAdmin = await createUserClient(t, owner, "sadmin@example.com", [{ roleKey: "server_admin", scopeType: "global", scopeId: null }]);
    expect(await status(serverAdmin.get("/database-hosts"))).toBe("403 FORBIDDEN");
    expect(await status(serverAdmin.post(`/database-hosts/${host.id}/test`))).toBe("403 FORBIDDEN");
    const infra = await createUserClient(t, owner, "infra@example.com", [{ roleKey: "infra_admin", scopeType: "global", scopeId: null }]);
    expect((await infra.get("/database-hosts")).statusCode).toBe(200);
    const { rows: denied } = await testPool().query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'authz.denied' AND details->>'permission' = 'database_hosts.manage'");
    expect(denied[0].n).toBeGreaterThanOrEqual(2);

    // Audit trail: what changed, never the password.
    const { rows: audit } = await testPool().query("SELECT action, details FROM audit_events WHERE target_type = 'database_host' ORDER BY id");
    expect(audit.map((a) => a.action)).toEqual(["database_host.create", ...Array<string>(5).fill("database_host.update")]);
    expect(audit[4].details.changes).toMatchObject({ tlsMode: "verify_ca", tlsCaCertificate: "[pinned]" });
    expect(audit[5].details.changes).toMatchObject({ tlsMode: "required", tlsCaCertificate: null });
    expect(audit[2].details).toMatchObject({ passwordChanged: true });

    // Delete refused while the host has databases; allowed afterwards.
    const srv = await paperServer(owner, { databaseLimit: 1 });
    const made = await owner.post(`/servers/${srv.id}/databases`, { name: "keep" });
    expect(made.statusCode, made.body).toBe(201);
    const del = await owner.delete(`/database-hosts/${host.id}`);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.details).toEqual({ reason: "has_databases", count: 1 });
    expect(DatabaseHost.parse((await owner.get(`/database-hosts/${host.id}`)).json()).databaseCount).toBe(1);
    expect((await owner.delete(`/servers/${srv.id}/databases/${made.json().id}`)).statusCode).toBe(204);
    expect((await owner.delete(`/database-hosts/${host.id}`)).statusCode).toBe(204);
    expect((await owner.get(`/database-hosts/${host.id}`)).statusCode).toBe(404);

    await expectNoLeak([adminPassword, "definitely-wrong-password-123", "now-wrong-password-456"]);
  });
});

describe.each(TARGETS)("server databases on $name", (target) => {
  it.skipIf(target === MYSQL && !MYSQL_UP)("creates a database whose user reaches only that database, rotates the password and deletes both", async () => {
    responseLog.length = 0;
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    const alice = await createUserClient(t, owner, "alice@example.com", []);
    const host = await createHost(owner, target, { publicHost: "db.example.net" });
    const srv = await paperServer(owner, { ownerId: await userId(alice), databaseLimit: 3 });

    // A database the server's users must never reach.
    const r = await root(target);
    await r.query(`CREATE DATABASE \`${FOREIGN_DB}\``);
    await r.query(`CREATE TABLE \`${FOREIGN_DB}\`.secrets (v TEXT)`);

    // An underscore in the name: `_` is a wildcard in database-level grants (must be escaped).
    const created = await alice.post(`/servers/${srv.id}/databases`, { name: "shop_data", remote: "%" });
    expect(created.statusCode, created.body).toBe(201);
    const db = ServerDatabase.parse(created.json());
    expect(db).toMatchObject({ serverId: srv.id, hostId: host.id, hostName: target.name, host: "db.example.net", port: target.port, database: `s${srv.shortId}_shop_data`, remote: "%", passwordRotatedAt: null });
    expect(db.username).toMatch(new RegExp(`^u${srv.shortId}_[a-z0-9]{10}$`));
    const second = ServerDatabase.parse((await alice.post(`/servers/${srv.id}/databases`, { name: "logs" })).json());
    expect((await alice.get(`/servers/${srv.id}/databases`)).json().map((d: ServerDatabase) => d.database)).toEqual([db.database, second.database]);

    // On the host: the database (utf8mb4), the account, and a grant on exactly that database without GRANT OPTION.
    const [schemata] = await r.query("SELECT default_character_set_name AS cs FROM information_schema.schemata WHERE schema_name = ?", [db.database]);
    expect((schemata as { cs: string }[])[0]?.cs).toBe("utf8mb4");
    const [grantRows] = await r.query(`SHOW GRANTS FOR \`${db.username}\`@\`%\``);
    const grants = (grantRows as Record<string, string>[]).map((g) => Object.values(g)[0]!);
    const onOwn = `ON \`${db.database.replaceAll("_", "\\_")}\`.*`;
    expect(grants.some((g) => g.includes(onOwn)), grants.join("\n")).toBe(true);
    expect(grants.filter((g) => !g.startsWith("GRANT USAGE ON *.*") && !g.includes(onOwn))).toEqual([]);
    expect(grants.join("\n")).not.toMatch(/WITH GRANT OPTION|GRANT OPTION/);

    // The password works for this database only.
    const pw = await alice.get(`/servers/${srv.id}/databases/${db.id}/password`);
    expect(pw.statusCode).toBe(200);
    expect(pw.headers["cache-control"]).toBe("no-store");
    const password = ServerDatabasePassword.parse(pw.json()).password;
    expect(password).toMatch(/^[A-Za-z0-9._~-]{32}$/);
    const u = await asUser(target, db, password);
    await u.query("CREATE TABLE players (id INT PRIMARY KEY, name VARCHAR(16))");
    await u.query("INSERT INTO players VALUES (1, 'Steve')");
    await u.query("CREATE VIEW v AS SELECT name FROM players");
    expect(((await u.query("SELECT name FROM v"))[0] as { name: string }[])[0]?.name).toBe("Steve");
    const [visible] = await u.query("SHOW DATABASES");
    // MySQL shows performance_schema to every account (built-in public tables); nothing else but its own database.
    const system = new Set(["information_schema", "performance_schema"]);
    expect((visible as { Database: string }[]).map((x) => x.Database).filter((n) => !system.has(n))).toEqual([db.database]);
    expect(await queryError(u, `SELECT * FROM \`${FOREIGN_DB}\`.secrets`)).toMatch(/ACCESS_DENIED/);
    expect(await queryError(u, `USE \`${second.database}\``)).toMatch(/ACCESS_DENIED/);
    expect(await queryError(u, `CREATE TABLE \`${second.database}\`.x (a INT)`)).toMatch(/ACCESS_DENIED/);
    expect(await queryError(u, "CREATE DATABASE `s00000000_evil`")).toMatch(/ACCESS_DENIED/);
    // Would be allowed by an unescaped wildcard grant on `s…_shop_data` (`_` matches any character).
    expect(await queryError(u, `CREATE DATABASE \`s${srv.shortId}_shopXdata\``)).toMatch(/ACCESS_DENIED/);
    expect(await queryError(u, `CREATE DATABASE \`s${srv.shortId}Xshop_data\``)).toMatch(/ACCESS_DENIED/);
    expect(await queryError(u, "CREATE USER `u00000000_evilevilev`@`%`")).toMatch(/ACCESS_DENIED|SPECIFIC_ACCESS/);
    expect(await queryError(u, `GRANT SELECT ON \`${db.database}\`.* TO \`${second.username}\`@\`%\``)).toMatch(/ACCESS_DENIED/);
    expect(await queryError(u, "SELECT user FROM mysql.user")).toMatch(/ACCESS_DENIED/);
    await u.end();

    // Rotation: the old password stops working, the new one works, and data stays.
    const rotated = await alice.post(`/servers/${srv.id}/databases/${db.id}/rotate-password`);
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(ServerDatabase.parse(rotated.json()).passwordRotatedAt).toEqual(expect.any(Number));
    const newPassword = ServerDatabasePassword.parse((await alice.get(`/servers/${srv.id}/databases/${db.id}/password`)).json()).password;
    expect(newPassword).not.toBe(password);
    expect(await connectError(target, db, password)).toBe("ER_ACCESS_DENIED_ERROR");
    const u2 = await asUser(target, db, newPassword);
    expect(((await u2.query("SELECT count(*) AS n FROM players"))[0] as { n: number }[])[0]?.n).toBe(1);
    await u2.end();

    // Delete: database and account are gone from the host, the row too.
    expect((await alice.delete(`/servers/${srv.id}/databases/${db.id}`)).statusCode).toBe(204);
    const [left] = await r.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?", [db.database]);
    expect(left).toEqual([]);
    const [acct] = await r.query("SELECT user FROM mysql.user WHERE user = ?", [db.username]);
    expect(acct).toEqual([]);
    expect(await connectError(target, db, newPassword)).toBe("ER_ACCESS_DENIED_ERROR");
    expect((await alice.get(`/servers/${srv.id}/databases`)).json()).toHaveLength(1);
    expect(await status(alice.delete(`/servers/${srv.id}/databases/${db.id}`))).toBe("404 NOT_FOUND");
    await r.end();

    // Audit: create ×2, password view ×2, rotate, delete — without any password.
    const { rows } = await testPool().query("SELECT action, outcome FROM audit_events WHERE action LIKE 'server.database.%' ORDER BY id");
    expect(rows.map((x) => `${x.action}:${x.outcome}`)).toEqual([
      "server.database.create:success",
      "server.database.create:success",
      "server.database.password.view:success",
      "server.database.rotate_password:success",
      "server.database.password.view:success",
      "server.database.delete:success",
    ]);
    await expectNoLeak([password, newPassword, target.password], (url) => url.endsWith("/password"));
  });
});

describe("server databases: limits, permissions and validation", () => {
  it("enforces limits, host choice, permissions (view_password separately) and validates names and host patterns", async () => {
    const { t, owner } = await boot();
    const node = await connectSimNode(t, owner, { agents });
    const alice = await createUserClient(t, owner, "alice@example.com", []);
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    const carol = await createUserClient(t, owner, "carol@example.com", []);
    const aliceId = await userId(alice);

    // No host yet → 422 no_host.
    const srv = await paperServer(owner, { ownerId: aliceId, databaseLimit: 2 });
    expect(await status(alice.post(`/servers/${srv.id}/databases`, { name: "a" }))).toBe("422 PRECONDITION_FAILED no_host");

    // Two hosts: one linked to another node (full), one linked to the server's node → node host first.
    const other = await connectSimNode(t, owner, { agents, ports: "" });
    const far = await createHost(owner, MARIADB, { name: "Far", nodeId: other.nodeId });
    const near = await createHost(owner, MARIADB, { name: "Near", nodeId: node.nodeId, maxDatabases: 1 });
    const first = ServerDatabase.parse((await alice.post(`/servers/${srv.id}/databases`, { name: "first" })).json());
    expect(first.hostId).toBe(near.id);
    // Near is full now → the fallback is the host linked to the other node.
    const second = ServerDatabase.parse((await alice.post(`/servers/${srv.id}/databases`, { name: "second", remote: "10.1.0.0/16" })).json());
    expect(second.hostId).toBe(far.id);
    expect(second.remote).toBe("10.1.0.0/255.255.0.0");
    const r = await root(MARIADB);
    const [acct] = await r.query("SELECT host AS host FROM mysql.user WHERE user = ?", [second.username]);
    expect(acct).toEqual([{ host: "10.1.0.0/255.255.0.0" }]);
    await r.end();

    // Limit: alice (owner, not an administrator) is at 2/2; the installation owner (servers.admin) is not limited.
    const limited = await alice.post(`/servers/${srv.id}/databases`, { name: "third" });
    expect(limited.statusCode).toBe(409);
    expect(limited.json().error.details).toEqual({ reason: "limit_reached", limit: 2 });
    const byAdmin = await owner.post(`/servers/${srv.id}/databases`, { name: "third" });
    expect(byAdmin.statusCode, byAdmin.body).toBe(201);
    // Picking a host: administrators only; a full host is refused.
    expect(await status(alice.post(`/servers/${srv.id}/databases`, { name: "pick", hostId: far.id }))).toBe("403 FORBIDDEN");
    expect(await status(owner.post(`/servers/${srv.id}/databases`, { name: "pick", hostId: near.id }))).toBe("409 CONFLICT host_full");
    expect(ServerDatabase.parse((await owner.post(`/servers/${srv.id}/databases`, { name: "pick", hostId: far.id })).json()).hostId).toBe(far.id);
    expect(await status(owner.post(`/servers/${srv.id}/databases`, { name: "pick" }))).toBe("409 CONFLICT name_taken");

    // Disabled (limit 0) for non-administrators.
    const off = await paperServer(owner, { ownerId: aliceId, databaseLimit: 0 });
    expect(await status(alice.post(`/servers/${off.id}/databases`, { name: "x" }))).toBe("403 FORBIDDEN disabled");
    expect((await alice.get(`/servers/${off.id}/databases`)).json()).toEqual([]);
    // Raising the limit through the build route enables it.
    expect((await owner.patch(`/servers/${off.id}/build`, { databaseLimit: 1 })).json().server.databaseLimit).toBe(1);
    expect((await alice.post(`/servers/${off.id}/databases`, { name: "x" })).statusCode).toBe(201);
    // Concurrent creations cannot overshoot the limit.
    expect((await owner.patch(`/servers/${off.id}/build`, { databaseLimit: 3 })).statusCode).toBe(200);
    const race = await Promise.all(["r1", "r2", "r3", "r4"].map((name) => alice.post(`/servers/${off.id}/databases`, { name })));
    expect(race.map((x) => x.statusCode).sort()).toEqual([201, 201, 409, 409]);
    expect((await alice.get(`/servers/${off.id}/databases`)).json()).toHaveLength(3);
    expect((await owner.patch(`/servers/${off.id}/build`, { databaseLimit: 1 })).statusCode).toBe(200);
    // Lowered below the usage: existing databases stay, new ones are refused.
    expect(await status(alice.post(`/servers/${off.id}/databases`, { name: "r5" }))).toBe("409 CONFLICT limit_reached");

    // Validation (identifier allowlist; injection attempts never reach the host).
    for (const name of ["Shop", "a-b", "x`; DROP DATABASE mysql; --", "a'b", "x".repeat(49), "", "a b", "../x"]) {
      expect(await status(alice.post(`/servers/${off.id}/databases`, { name })), name).toBe("400 VALIDATION_FAILED");
    }
    for (const remote of ["%' IDENTIFIED BY 'x", "`%`", "10.0.0.1/8", "10.0.0.0/40", "a b", "host;drop", ""]) {
      expect(await status(alice.post(`/servers/${off.id}/databases`, { name: "ok", remote })), remote).toBe("400 VALIDATION_FAILED");
    }
    expect(await status(alice.post(`/servers/${off.id}/databases`, { name: "ok", password: "mine" }))).toBe("400 VALIDATION_FAILED");

    // Subusers: view only → list but no password/rotate/create/delete; + view_password → password.
    await alice.post(`/servers/${srv.id}/subusers`, { user: "bob", permissions: ["servers.view", "servers.databases.view"] });
    const list = await bob.get(`/servers/${srv.id}/databases`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(4);
    for (const d of list.json()) ServerDatabase.parse(d);
    expect(await status(bob.get(`/servers/${srv.id}/databases/${first.id}/password`))).toBe("403 FORBIDDEN");
    expect(await status(bob.post(`/servers/${srv.id}/databases/${first.id}/rotate-password`))).toBe("403 FORBIDDEN");
    expect(await status(bob.delete(`/servers/${srv.id}/databases/${first.id}`))).toBe("403 FORBIDDEN");
    expect(await status(bob.post(`/servers/${srv.id}/databases`, { name: "bob" }))).toBe("403 FORBIDDEN");
    const subs = (await alice.get(`/servers/${srv.id}/subusers`)).json() as { id: string; username: string }[];
    const bobSub = subs.find((s) => s.username === "bob")!;
    expect((await alice.put(`/servers/${srv.id}/subusers/${bobSub.id}`, { permissions: ["servers.view", "servers.databases.view", "servers.databases.view_password"] })).statusCode).toBe(200);
    expect((await bob.get(`/servers/${srv.id}/databases/${first.id}/password`)).statusCode).toBe(200);
    expect(await status(bob.post(`/servers/${srv.id}/databases/${first.id}/rotate-password`))).toBe("403 FORBIDDEN");
    // A database of another server through this server's route: 404.
    const offDb = ((await alice.get(`/servers/${off.id}/databases`)).json() as ServerDatabase[])[0]!;
    expect(await status(alice.get(`/servers/${srv.id}/databases/${offDb.id}/password`))).toBe("404 NOT_FOUND");
    // Strangers do not learn that the server exists.
    expect(await status(carol.get(`/servers/${srv.id}/databases`))).toBe("404 NOT_FOUND");
    expect(await status(carol.get(`/servers/${srv.id}/databases/${first.id}/password`))).toBe("404 NOT_FOUND");
    const { rows: denied } = await testPool().query("SELECT details->>'permission' AS p FROM audit_events WHERE action = 'authz.denied' AND target_id = $1", [srv.id]);
    expect(denied.map((d) => d.p)).toEqual(expect.arrayContaining(["servers.databases.view_password", "servers.databases.update", "servers.databases.delete", "servers.databases.create"]));

    // Suspension: only administrators act on a suspended server.
    expect((await owner.post(`/servers/${srv.id}/suspend`)).statusCode).toBe(200);
    expect(await status(alice.get(`/servers/${srv.id}/databases/${first.id}/password`))).toBe("403 FORBIDDEN");
    expect((await alice.get(`/servers/${srv.id}/databases`)).statusCode).toBe(200);
    expect((await owner.post(`/servers/${srv.id}/unsuspend`)).statusCode).toBe(200);

    // An unreachable host: 502 host_error, nothing left behind.
    await owner.patch(`/database-hosts/${near.id}`, { port: 1, maxDatabases: null, password: MARIADB.password });
    const before = (await alice.get(`/servers/${off.id}/databases`)).json().length;
    expect(await status(owner.post(`/servers/${off.id}/databases`, { name: "down", hostId: near.id }))).toBe("502 UPSTREAM_ERROR host_error");
    expect((await alice.get(`/servers/${off.id}/databases`)).json()).toHaveLength(before);
    const failed = await owner.post(`/servers/${srv.id}/databases/${first.id}/rotate-password`);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.details).toEqual({ reason: "host_error", code: "ECONNREFUSED" });
    expect(await status(owner.delete(`/servers/${srv.id}/databases/${first.id}`))).toBe("502 UPSTREAM_ERROR host_error");
    expect((await alice.get(`/servers/${srv.id}/databases`)).json().some((d: ServerDatabase) => d.id === first.id)).toBe(true);
    const { rows: failures } = await testPool().query("SELECT action FROM audit_events WHERE outcome = 'failed' AND action LIKE 'server.database.%' ORDER BY id");
    expect(failures.map((f) => f.action)).toEqual(["server.database.create", "server.database.rotate_password", "server.database.delete"]);
    await expectNoLeak([MARIADB.password], (url) => url.endsWith("/password"));

    // Password reads are rate limited per client (60 per minute per route).
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await bob.get(`/servers/${srv.id}/databases/${first.id}/password`)).statusCode);
    expect(codes).toContain(429);
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(60);
  });

  it("refuses a database name that already exists on the host and undoes nothing it did not create", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    await createHost(owner, MARIADB);
    const srv = await paperServer(owner, { databaseLimit: 2 });
    const r = await root(MARIADB);
    const name = `s${srv.shortId}_taken`;
    await r.query(`CREATE DATABASE \`${name}\``);
    await r.query(`CREATE TABLE \`${name}\`.keep (a INT)`);
    const res = await owner.post(`/servers/${srv.id}/databases`, { name: "taken" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ reason: "name_taken" });
    // The pre-existing database is untouched and no row/account was left behind.
    const [tables] = await r.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?", [name]);
    expect(tables).toEqual([{ t: "keep" }]);
    const [users] = await r.query("SELECT user FROM mysql.user WHERE user LIKE ?", [`u${srv.shortId}_%`]);
    expect(users).toEqual([]);
    expect((await owner.get(`/servers/${srv.id}/databases`)).json()).toEqual([]);
    const { rows } = await testPool().query("SELECT outcome, details FROM audit_events WHERE action = 'server.database.create'");
    expect(rows).toEqual([expect.objectContaining({ outcome: "failed", details: expect.objectContaining({ code: "ER_DB_CREATE_EXISTS" }) })]);
    await r.end();
  });
});

describe.skipIf(!MYSQL_UP)("MySQL with partial_revokes = ON", () => {
  it("grants on the literal database name (no escape) and the user still reaches only its own database", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    await createHost(owner, MYSQL);
    const srv = await paperServer(owner, { databaseLimit: 1 });
    const r = await root(MYSQL);
    await r.query("SET GLOBAL partial_revokes = ON");
    try {
      const db = ServerDatabase.parse((await owner.post(`/servers/${srv.id}/databases`, { name: "a_b" })).json());
      const [grantRows] = await r.query(`SHOW GRANTS FOR \`${db.username}\`@\`%\``);
      const grants = (grantRows as Record<string, string>[]).map((g) => Object.values(g)[0]!).join("\n");
      expect(grants).toContain(`ON \`${db.database}\`.*`);
      expect(grants).not.toContain("\\_");
      const password = ServerDatabasePassword.parse((await owner.get(`/servers/${srv.id}/databases/${db.id}/password`)).json()).password;
      const u = await asUser(MYSQL, db, password);
      await u.query("CREATE TABLE t (a INT)");
      expect(await queryError(u, `CREATE DATABASE \`s${srv.shortId}_aXb\``)).toMatch(/ACCESS_DENIED/);
      await u.end();
    } finally {
      await r.query("SET GLOBAL partial_revokes = OFF");
      await r.end();
    }
  });
});

const countRows = async (sql: string, params: unknown[] = []) => (await testPool().query<{ n: number }>(sql, params)).rows[0]!.n;

describe("host operations never hold Postgres resources; one operation per database", () => {
  it("rotations and deletions against a hanging host hold no transaction, lock or pool connection; a second operation on the same database is busy", async () => {
    const { t, owner } = await boot({ connectTimeoutMs: 6000 });
    await connectSimNode(t, owner, { agents });
    const host = await createHost(owner, MARIADB);
    const srv = await paperServer(owner, { databaseLimit: 1 });
    // 12 databases — more than the 10 connections of the test pool (the installation owner is not limited).
    const dbs: ServerDatabase[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await owner.post(`/servers/${srv.id}/databases`, { name: `h${i}` });
      expect(res.statusCode, res.body).toBe(201);
      dbs.push(ServerDatabase.parse(res.json()));
    }
    const first = dbs[0]!;
    const passwordOf = async (d: ServerDatabase) => ServerDatabasePassword.parse((await owner.get(`/servers/${srv.id}/databases/${d.id}/password`)).json()).password;
    const oldPassword = await passwordOf(first);
    const hang = await hangingHost();
    expect((await owner.patch(`/database-hosts/${host.id}`, { port: hang.port, password: MARIADB.password })).statusCode).toBe(200);
    // Probes use their own connection: the app shares the 10-connection test pool, which must stay free.
    const probe = new pg.Client({ connectionString: TEST_DATABASE_URL });
    probes.push(probe);
    await probe.connect();
    const probeCount = async (sql: string) => (await probe.query<{ n: number }>(sql)).rows[0]!.n;
    const IDLE_IN_TX = "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%' AND query ILIKE '%server_databases%'";
    const LOCKS = "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'server_databases' AND l.pid <> pg_backend_pid()";

    const started = Date.now();
    const rotations = dbs.map((d) => owner.post(`/servers/${srv.id}/databases/${d.id}/rotate-password`));
    // Wait until the hanging host holds the connections (≥ 10 = the pool size, so this also holds when an
    // implementation pins a pool connection per operation), then look at Postgres.
    await poll(async () => hang.open() >= 10, 5000, 25);
    await new Promise((r) => setTimeout(r, 200));
    // No open transaction touches server_databases, no lock is held on it, every one of the 12 reached the
    // host (none is waiting for a pool connection), and unrelated requests are served at once.
    expect(await probeCount(IDLE_IN_TX)).toBe(0);
    expect(await probeCount(LOCKS)).toBe(0);
    expect(hang.open()).toBe(12);
    expect(await countRows("SELECT count(*)::int AS n FROM server_databases WHERE operation = 'rotating'")).toBe(12);
    const t0 = Date.now();
    expect((await owner.get(`/servers/${srv.id}/databases`)).statusCode).toBe(200);
    expect((await owner.get(`/servers/${srv.id}`)).statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2500);
    // A second operation on a database being rotated is refused cleanly; reading its password is not blocked.
    expect(await status(owner.delete(`/servers/${srv.id}/databases/${first.id}`))).toBe("409 CONFLICT busy");
    expect(await status(owner.post(`/servers/${srv.id}/databases/${first.id}/rotate-password`))).toBe("409 CONFLICT busy");
    expect(await passwordOf(first)).toBe(oldPassword);
    expect(Date.now() - started).toBeLessThan(6000); // all of the above happened while the rotations were pending

    const results = await Promise.all(rotations);
    expect(results.map((r) => r.statusCode)).toEqual(Array<number>(12).fill(502));
    expect(results[0]!.json().error.details).toEqual({ reason: "host_error", code: "ETIMEDOUT" });
    // Claims released; the old password is still the one stored and the one the host accepts.
    expect(await countRows("SELECT count(*)::int AS n FROM server_databases WHERE operation IS NOT NULL")).toBe(0);
    expect(await passwordOf(first)).toBe(oldPassword);
    await (await asUser(MARIADB, first, oldPassword)).end();

    // Deletion against the hanging host: the same database cannot be rotated meanwhile; the 502 keeps the row.
    const deleting = owner.delete(`/servers/${srv.id}/databases/${first.id}`);
    await poll(async () => hang.open() >= 1, 5000, 25);
    await new Promise((r) => setTimeout(r, 200));
    expect(await probeCount(IDLE_IN_TX)).toBe(0);
    expect(await probeCount(LOCKS)).toBe(0);
    expect(await countRows("SELECT count(*)::int AS n FROM server_databases WHERE operation = 'deleting'")).toBe(1);
    expect(await status(owner.post(`/servers/${srv.id}/databases/${first.id}/rotate-password`))).toBe("409 CONFLICT busy");
    expect(await status(deleting)).toBe("502 UPSTREAM_ERROR host_error");
    expect(((await owner.get(`/servers/${srv.id}/databases`)).json() as ServerDatabase[]).some((d) => d.id === first.id)).toBe(true);
    expect(await countRows("SELECT count(*)::int AS n FROM server_databases WHERE operation IS NOT NULL")).toBe(0);

    // An abandoned claim (process crash) blocks until it is stale, then is taken over.
    expect((await owner.patch(`/database-hosts/${host.id}`, { port: MARIADB.port, password: MARIADB.password })).statusCode).toBe(200);
    await testPool().query("UPDATE server_databases SET operation = 'rotating', operation_token = gen_random_uuid(), operation_started_at = now() WHERE id = $1", [first.id]);
    expect(await status(owner.post(`/servers/${srv.id}/databases/${first.id}/rotate-password`))).toBe("409 CONFLICT busy");
    await testPool().query("UPDATE server_databases SET operation_started_at = now() - interval '10 minutes' WHERE id = $1", [first.id]);
    expect((await owner.post(`/servers/${srv.id}/databases/${first.id}/rotate-password`)).statusCode).toBe(200);
    const rotated = await passwordOf(first);
    expect(rotated).not.toBe(oldPassword);
    expect(await connectError(MARIADB, first, oldPassword)).toBe("ER_ACCESS_DENIED_ERROR");
    await (await asUser(MARIADB, first, rotated)).end();
  }, 120_000);

  it("concurrent rotate and delete of one database: one wins, the other is refused or finds it gone, and host and row agree", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    await createHost(owner, MARIADB);
    const srv = await paperServer(owner, { databaseLimit: 1 });
    const r = await root(MARIADB);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const db = ServerDatabase.parse((await owner.post(`/servers/${srv.id}/databases`, { name: `race${i}` })).json());
      const [rot, del] = await Promise.all([
        owner.post(`/servers/${srv.id}/databases/${db.id}/rotate-password`),
        owner.delete(`/servers/${srv.id}/databases/${db.id}`),
      ]);
      seen.add(`${rot.statusCode}/${del.statusCode}`);
      expect([200, 404, 409], rot.body).toContain(rot.statusCode);
      expect([204, 409], del.body).toContain(del.statusCode);
      expect(rot.statusCode === 409 && del.statusCode === 409).toBe(false);
      const [onHost] = await r.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?", [db.database]);
      const [account] = await r.query("SELECT user FROM mysql.user WHERE user = ?", [db.username]);
      const row = await countRows("SELECT count(*)::int AS n FROM server_databases WHERE id = $1", [db.id]);
      if (del.statusCode === 204) {
        expect([row, (onHost as unknown[]).length, (account as unknown[]).length]).toEqual([0, 0, 0]);
      } else {
        expect([row, (onHost as unknown[]).length, (account as unknown[]).length]).toEqual([1, 1, 1]);
        expect(await countRows("SELECT count(*)::int AS n FROM server_databases WHERE id = $1 AND operation IS NULL", [db.id])).toBe(1);
        const pw = ServerDatabasePassword.parse((await owner.get(`/servers/${srv.id}/databases/${db.id}/password`)).json()).password;
        await (await asUser(MARIADB, db, pw)).end();
        expect((await owner.delete(`/servers/${srv.id}/databases/${db.id}`)).statusCode).toBe(204);
      }
    }
    await r.end();
    expect(seen.size).toBeGreaterThan(0);
  }, 120_000);
});

describe("edge cases on the host", () => {
  it("a pre-existing database account with the generated name: create fails safely and never drops or changes that account", async () => {
    const { t, owner } = await boot({ generateUsername: (s) => `u${s}_collision0` });
    await connectSimNode(t, owner, { agents });
    await createHost(owner, MARIADB);
    const srv = await paperServer(owner, { databaseLimit: 2 });
    const victim = `u${srv.shortId}_collision0`;
    const theirs = "Pre-existing-Passw0rd";
    const r = await root(MARIADB);
    await r.query(`CREATE DATABASE \`${FOREIGN_DB}\``);
    await r.query(`CREATE USER \`${victim}\`@\`%\` IDENTIFIED BY '${theirs}'`);
    await r.query(`GRANT SELECT ON \`${FOREIGN_DB}\`.* TO \`${victim}\`@\`%\``);

    const res = await owner.post(`/servers/${srv.id}/databases`, { name: "victim" });
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json().error.details).toEqual({ reason: "host_error", code: "ER_CANNOT_USER" });
    // The account is untouched: same password, same grant; the database this request created is gone again.
    const own = await mysql.createConnection({ host: MARIADB.host, port: MARIADB.port, user: victim, password: theirs, database: FOREIGN_DB, ssl: { rejectUnauthorized: false } });
    await own.end();
    const [grants] = await r.query(`SHOW GRANTS FOR \`${victim}\`@\`%\``);
    expect((grants as Record<string, string>[]).map((g) => Object.values(g)[0]!).join("\n")).toContain(`ON \`${FOREIGN_DB}\`.*`);
    const [dbs] = await r.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?", [`s${srv.shortId}_victim`]);
    expect(dbs).toEqual([]);
    expect((await owner.get(`/servers/${srv.id}/databases`)).json()).toEqual([]);
    const { rows } = await testPool().query("SELECT outcome, details FROM audit_events WHERE action = 'server.database.create'");
    expect(rows).toEqual([expect.objectContaining({ outcome: "failed", details: expect.objectContaining({ code: "ER_CANNOT_USER", username: victim }) })]);
    await r.end();
  });

  it("an IPv6 account host (::1): created, granted, rotated and dropped for exactly that host", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    await createHost(owner, MARIADB);
    const srv = await paperServer(owner, { databaseLimit: 1 });
    const db = ServerDatabase.parse((await owner.post(`/servers/${srv.id}/databases`, { name: "v6", remote: "::1" })).json());
    expect(db.remote).toBe("::1");
    const r = await root(MARIADB);
    const [acct] = await r.query("SELECT host AS host FROM mysql.user WHERE user = ?", [db.username]);
    expect(acct).toEqual([{ host: "::1" }]);
    const [grantRows] = await r.query(`SHOW GRANTS FOR \`${db.username}\`@\`::1\``);
    expect((grantRows as Record<string, string>[]).map((g) => Object.values(g)[0]!).join("\n")).toContain(`ON \`${db.database.replaceAll("_", "\\_")}\`.*`);
    // This client reaches MariaDB over IPv4 (Docker's port proxy), so the ::1-only account must refuse it.
    const password = ServerDatabasePassword.parse((await owner.get(`/servers/${srv.id}/databases/${db.id}/password`)).json()).password;
    expect(await connectError(MARIADB, db, password)).toMatch(/ER_ACCESS_DENIED_ERROR|ER_HOST_NOT_PRIVILEGED/);
    expect((await owner.post(`/servers/${srv.id}/databases/${db.id}/rotate-password`)).statusCode).toBe(200);
    expect((await owner.delete(`/servers/${srv.id}/databases/${db.id}`)).statusCode).toBe(204);
    const [gone] = await r.query("SELECT host FROM mysql.user WHERE user = ?", [db.username]);
    expect(gone).toEqual([]);
    await r.end();
  });
});

describe("server deletion", () => {
  it("drops the server's databases on every host (best effort) and records what could not be dropped", async () => {
    const { t, owner } = await boot();
    await connectSimNode(t, owner, { agents });
    // Two host entries for the same MariaDB server; the second one becomes unreachable after the creations.
    const maria = await createHost(owner, MARIADB);
    const my = await createHost(owner, MARIADB, { name: "Second entry" });
    const srv = await paperServer(owner, { databaseLimit: 3 });
    const a = ServerDatabase.parse((await owner.post(`/servers/${srv.id}/databases`, { name: "a", hostId: maria.id })).json());
    const b = ServerDatabase.parse((await owner.post(`/servers/${srv.id}/databases`, { name: "b", hostId: maria.id })).json());
    const c = ServerDatabase.parse((await owner.post(`/servers/${srv.id}/databases`, { name: "c", hostId: my.id })).json());
    // Its database cannot be dropped, which must not block the deletion.
    expect((await owner.patch(`/database-hosts/${my.id}`, { port: 1, password: MARIADB.password })).statusCode).toBe(200);

    const del = await owner.delete(`/servers/${srv.id}`);
    expect(del.statusCode, del.body).toBe(202);
    const job = await waitJob(owner, del.json().jobId);
    expect(job.status).toBe("succeeded");
    expect(job.steps).toEqual(expect.arrayContaining([expect.objectContaining({ key: "databases", status: "succeeded" })]));

    const mr = await root(MARIADB);
    const [left] = await mr.query("SELECT schema_name AS n FROM information_schema.schemata WHERE schema_name IN (?, ?, ?)", [a.database, b.database, c.database]);
    expect(left).toEqual([{ n: c.database }]);
    const [accts] = await mr.query("SELECT user AS u FROM mysql.user WHERE user IN (?, ?, ?)", [a.username, b.username, c.username]);
    expect(accts).toEqual([{ u: c.username }]);
    await mr.end();

    const { rows } = await testPool().query("SELECT outcome, details FROM audit_events WHERE action = 'server.database.delete' ORDER BY id");
    expect(rows.map((x) => `${x.details.database}:${x.outcome}`).sort()).toEqual([`${a.database}:success`, `${b.database}:success`, `${c.database}:failed`].sort());
    expect(rows.find((x) => x.outcome === "failed")!.details).toMatchObject({ reason: "server_deleted", hostId: my.id, code: "ECONNREFUSED", username: c.username });
    const logs = ((await owner.get(`/jobs/${del.json().jobId}/logs`)).json() as { level: string; message: string }[]);
    expect(logs.some((l) => l.level === "warn" && l.message.includes(c.database) && l.message.includes("could not be dropped"))).toBe(true);
    const { rows: remaining } = await testPool().query("SELECT count(*)::int AS n FROM server_databases");
    expect(remaining[0].n).toBe(0);
    // Both hosts can be deleted now.
    expect((await owner.delete(`/database-hosts/${maria.id}`)).statusCode).toBe(204);
    expect((await owner.delete(`/database-hosts/${my.id}`)).statusCode).toBe(204);
  });
});
