import { randomUUID, X509Certificate } from "node:crypto";
import type {
  CreateDatabaseHostRequest,
  DatabaseHost,
  DatabaseHostTestResult,
  DatabaseTlsMode,
  TestDatabaseHostRequest,
  UpdateDatabaseHostRequest,
} from "@blockforge/contracts";
import { asc, count, eq } from "drizzle-orm";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db, DbOrTx } from "../db/client.js";
import { databaseHosts, nodes, serverDatabases } from "../db/schema/index.js";
import type { Clock } from "../lib/clock.js";
import { AppError, badRequest, conflict, notFound, validationDetails } from "../lib/errors.js";
import type { SecretBox } from "../secrets/secret-box.js";
import type { HostConnection, MysqlConnector } from "./mysql.js";

export type HostRow = typeof databaseHosts.$inferSelect;

const hostAad = (id: string) => `database-host:${id}`;

/** Connection settings whose change requires the admin password again (a stored password is never sent elsewhere). */
const CONNECTION_FIELDS = ["host", "port", "username", "tlsMode", "tlsCaCertificate"] as const;
const PASSWORD_REQUIRED = "Re-enter the admin password when changing the connection settings";

/** Every certificate of a PEM bundle must parse (refuses junk before it reaches the TLS stack). */
function checkPem(pem: string | null | undefined, path: string): void {
  if (!pem) return;
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  try {
    if (!blocks.length) throw new Error("no certificate");
    for (const b of blocks) new X509Certificate(b);
  } catch {
    throw badRequest("The CA certificate is not a valid PEM certificate", validationDetails("not a valid PEM certificate", path));
  }
}

export interface DatabaseHostsDeps {
  db: Db;
  clock: Clock;
  box: SecretBox;
  audit: AuditService;
  connector: MysqlConnector;
}

/** Admin CRUD of database hosts (api.md "Databases"); the admin password is write-only. */
export class DatabaseHostsService {
  constructor(private readonly d: DatabaseHostsDeps) {}

  private async toDtos(rows: HostRow[], tx: DbOrTx = this.d.db): Promise<DatabaseHost[]> {
    if (!rows.length) return [];
    const counts = new Map<string, number>();
    for (const c of await tx.select({ hostId: serverDatabases.hostId, n: count() }).from(serverDatabases).groupBy(serverDatabases.hostId)) {
      counts.set(c.hostId, Number(c.n));
    }
    const nodeNames = new Map<string, string>();
    for (const n of await tx.select({ id: nodes.id, name: nodes.name }).from(nodes)) nodeNames.set(n.id, n.name);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      publicHost: r.publicHost,
      username: r.username,
      nodeId: r.nodeId,
      nodeName: r.nodeId ? (nodeNames.get(r.nodeId) ?? null) : null,
      maxDatabases: r.maxDatabases,
      databaseCount: counts.get(r.id) ?? 0,
      tlsMode: r.tlsMode as DatabaseTlsMode,
      tlsCaCertificate: r.tlsCaCertificate,
      notes: r.notes,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
    }));
  }

  async row(id: string, tx: DbOrTx = this.d.db): Promise<HostRow> {
    const [r] = await tx.select().from(databaseHosts).where(eq(databaseHosts.id, id)).limit(1);
    if (!r) throw notFound("Database host");
    return r;
  }

  async list(): Promise<DatabaseHost[]> {
    return this.toDtos(await this.d.db.select().from(databaseHosts).orderBy(asc(databaseHosts.name), asc(databaseHosts.id)));
  }

  async get(id: string): Promise<DatabaseHost> {
    const [dto] = await this.toDtos([await this.row(id)]);
    return dto!;
  }

  /** Decrypted admin connection (plaintext password only in memory, for one operation). */
  connectionOf(r: HostRow): HostConnection {
    return {
      host: r.host,
      port: r.port,
      user: r.username,
      password: this.d.box.decryptString(r.passwordEnc, hostAad(r.id)),
      tlsMode: r.tlsMode as DatabaseTlsMode,
      tlsCaCertificate: r.tlsCaCertificate,
    };
  }

  private async checkNode(nodeId: string | null | undefined): Promise<void> {
    if (!nodeId) return;
    const [n] = await this.d.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!n) throw badRequest("Unknown node", validationDetails("unknown node", "nodeId"));
  }

  private async checkName(name: string, exceptId?: string): Promise<void> {
    const [r] = await this.d.db.select({ id: databaseHosts.id }).from(databaseHosts).where(eq(databaseHosts.name, name)).limit(1);
    if (r && r.id !== exceptId) throw conflict("A database host with this name already exists");
  }

  async create(req: CreateDatabaseHostRequest, actor: AuditActor): Promise<DatabaseHost> {
    checkPem(req.tlsCaCertificate, "tlsCaCertificate");
    await this.checkNode(req.nodeId);
    await this.checkName(req.name);
    const id = randomUUID();
    const now = new Date(this.d.clock.now());
    await this.d.db.transaction(async (tx) => {
      await tx.insert(databaseHosts).values({
        id,
        name: req.name,
        host: req.host,
        port: req.port,
        publicHost: req.publicHost,
        username: req.username,
        passwordEnc: this.d.box.encryptToString(req.password, hostAad(id)),
        nodeId: req.nodeId,
        maxDatabases: req.maxDatabases,
        tlsMode: req.tlsMode,
        tlsCaCertificate: req.tlsCaCertificate,
        notes: req.notes,
        createdAt: now,
        updatedAt: now,
      });
      await this.d.audit.record(
        {
          ...actor,
          action: "database_host.create",
          targetType: "database_host",
          targetId: id,
          outcome: "success",
          details: { name: req.name, host: req.host, port: req.port, username: req.username, nodeId: req.nodeId, maxDatabases: req.maxDatabases, tlsMode: req.tlsMode, caPinned: Boolean(req.tlsCaCertificate) },
        },
        tx,
      );
    });
    return this.get(id);
  }

  async update(id: string, req: UpdateDatabaseHostRequest, actor: AuditActor): Promise<DatabaseHost> {
    const r = await this.row(id);
    checkPem(req.tlsCaCertificate, "tlsCaCertificate");
    const changedConnection = CONNECTION_FIELDS.filter((k) => req[k] !== undefined && req[k] !== r[k]);
    if (changedConnection.length && req.password === undefined) throw badRequest(PASSWORD_REQUIRED, validationDetails(PASSWORD_REQUIRED, "password"));
    if (req.nodeId !== undefined) await this.checkNode(req.nodeId);
    if (req.name !== undefined) await this.checkName(req.name, id);
    // Lowering `maxDatabases` below the current usage is allowed: no new databases until usage drops.
    const set: Partial<typeof databaseHosts.$inferInsert> = {};
    const changes: Record<string, unknown> = {};
    for (const k of ["name", "host", "port", "publicHost", "username", "nodeId", "maxDatabases", "tlsMode", "tlsCaCertificate", "notes"] as const) {
      const v = req[k];
      if (v === undefined || v === r[k]) continue;
      (set as Record<string, unknown>)[k] = v;
      changes[k] = k === "tlsCaCertificate" ? (v === null ? null : "[pinned]") : v;
    }
    if (req.password !== undefined) set.passwordEnc = this.d.box.encryptToString(req.password, hostAad(id));
    if (Object.keys(set).length) {
      set.updatedAt = new Date(this.d.clock.now());
      await this.d.db.transaction(async (tx) => {
        await tx.update(databaseHosts).set(set).where(eq(databaseHosts.id, id));
        await this.d.audit.record(
          { ...actor, action: "database_host.update", targetType: "database_host", targetId: id, outcome: "success", details: { name: req.name ?? r.name, changes, passwordChanged: req.password !== undefined } },
          tx,
        );
      });
    }
    return this.get(id);
  }

  /** Refused (409 `has_databases`) while the host still has databases. */
  async remove(id: string, actor: AuditActor): Promise<void> {
    await this.d.db.transaction(async (tx) => {
      const [r] = await tx.select().from(databaseHosts).where(eq(databaseHosts.id, id)).for("update").limit(1);
      if (!r) throw notFound("Database host");
      const [n] = await tx.select({ n: count() }).from(serverDatabases).where(eq(serverDatabases.hostId, id));
      const used = Number(n?.n ?? 0);
      if (used > 0) throw conflict(`The database host still has ${used} database(s); delete them first`, { reason: "has_databases", count: used });
      await tx.delete(databaseHosts).where(eq(databaseHosts.id, id));
      await this.d.audit.record({ ...actor, action: "database_host.delete", targetType: "database_host", targetId: id, outcome: "success", details: { name: r.name, host: r.host, port: r.port } }, tx);
    });
  }

  async testSaved(id: string): Promise<DatabaseHostTestResult> {
    return this.d.connector.test(this.connectionOf(await this.row(id)));
  }

  /**
   * Tests unsaved settings. Without a password the saved host's password is used, but only when every
   * connection setting equals the saved one: the stored password never goes to another address.
   */
  async testUnsaved(req: TestDatabaseHostRequest): Promise<DatabaseHostTestResult> {
    checkPem(req.tlsCaCertificate, "tlsCaCertificate");
    let password = req.password;
    if (password === undefined) {
      if (!req.hostId) throw badRequest("Enter the password", validationDetails("required", "password"));
      const r = await this.row(req.hostId);
      const same = req.host === r.host && req.port === r.port && req.username === r.username && req.tlsMode === r.tlsMode && (req.tlsCaCertificate ?? null) === r.tlsCaCertificate;
      if (!same) throw badRequest(PASSWORD_REQUIRED, validationDetails(PASSWORD_REQUIRED, "password"));
      password = this.connectionOf(r).password;
    }
    return this.d.connector.test({ host: req.host, port: req.port, user: req.username, password, tlsMode: req.tlsMode, tlsCaCertificate: req.tlsCaCertificate ?? null });
  }
}

/** 502 for host failures (contracts `DatabaseErrorDetails` `host_error`). */
export function hostError(message: string, code: string | null): AppError {
  return new AppError(502, "UPSTREAM_ERROR", `Database host error: ${message}`, { reason: "host_error", code });
}
