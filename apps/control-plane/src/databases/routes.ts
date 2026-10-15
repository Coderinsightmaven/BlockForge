import { CreateDatabaseHostRequest, CreateServerDatabaseRequest, DeleteServerDatabaseQuery, TestDatabaseHostRequest, UpdateDatabaseHostRequest } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePermission, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { authorize, GLOBAL } from "../rbac/authorize.js";

const IdParams = z.object({ id: z.uuid() });
const DatabaseParams = IdParams.extend({ databaseId: z.uuid() });

/**
 * Per-IP limit on the routes that talk to a database host or reveal a password (connection attempts,
 * statement execution, credential reads); reads of lists are not limited.
 */
const HOST_RATE = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/** `/database-hosts…` (admin) and `/servers/:id/databases…` (api.md "Databases"). */
export function registerDatabaseRoutes(app: FastifyInstance, ctx: AppContext): void {
  const hosts = ctx.databaseHosts;
  const dbs = ctx.serverDatabases;
  const access = ctx.serverAccess;
  const admin = (req: Parameters<typeof requirePermission>[1]) => requirePermission(ctx.audit, req, "database_hosts.manage", GLOBAL);

  // --- Hosts (database_hosts.manage) ----------------------------------------------------------
  app.get("/database-hosts", async (req) => {
    await admin(req);
    return hosts.list();
  });

  app.post("/database-hosts", async (req, reply) => {
    await admin(req);
    return reply.status(201).send(await hosts.create(parse(CreateDatabaseHostRequest, req.body), actorOf(req)));
  });

  // Registered before `/:id` routes so "test" is never parsed as an id.
  app.post("/database-hosts/test", { config: HOST_RATE }, async (req) => {
    await admin(req);
    return hosts.testUnsaved(parse(TestDatabaseHostRequest, req.body));
  });

  app.get("/database-hosts/:id", async (req) => {
    await admin(req);
    return hosts.get(parse(IdParams, req.params, "Path").id);
  });

  app.patch("/database-hosts/:id", async (req) => {
    await admin(req);
    const { id } = parse(IdParams, req.params, "Path");
    return hosts.update(id, parse(UpdateDatabaseHostRequest, req.body), actorOf(req));
  });

  app.delete("/database-hosts/:id", async (req, reply) => {
    await admin(req);
    await hosts.remove(parse(IdParams, req.params, "Path").id, actorOf(req));
    return reply.status(204).send();
  });

  app.post("/database-hosts/:id/test", { config: HOST_RATE }, async (req) => {
    await admin(req);
    return hosts.testSaved(parse(IdParams, req.params, "Path").id);
  });

  // --- Server databases -----------------------------------------------------------------------
  app.get("/servers/:id/databases", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.databases.view");
    return dbs.list(a);
  });

  app.post("/servers/:id/databases", { config: HOST_RATE }, async (req, reply) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.databases.create");
    const body = parse(CreateServerDatabaseRequest, req.body);
    // Picking the host is an administrator choice (the host list itself is admin-only).
    const canPickHost = authorize(requirePrincipal(req), "database_hosts.manage", GLOBAL);
    if (body.hostId !== undefined && !canPickHost) await admin(req);
    return reply.status(201).send(await dbs.create(a, body, actorOf(req), canPickHost));
  });

  app.get("/servers/:id/databases/:databaseId/password", { config: HOST_RATE }, async (req, reply) => {
    const p = parse(DatabaseParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.databases.view_password");
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
    return dbs.password(a, p.databaseId, actorOf(req));
  });

  app.post("/servers/:id/databases/:databaseId/rotate-password", { config: HOST_RATE }, async (req) => {
    const p = parse(DatabaseParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.databases.update");
    return dbs.rotate(a, p.databaseId, actorOf(req));
  });

  app.delete("/servers/:id/databases/:databaseId", { config: HOST_RATE }, async (req, reply) => {
    const p = parse(DatabaseParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.databases.delete");
    const { forget } = parse(DeleteServerDatabaseQuery, req.query, "Query");
    if (forget) {
      // Leaves the database on the host: an administrator decision (hosts are administrators' infrastructure).
      await admin(req);
      await dbs.forget(a, p.databaseId, actorOf(req));
    } else {
      await dbs.remove(a, p.databaseId, actorOf(req));
    }
    return reply.status(204).send();
  });
}
