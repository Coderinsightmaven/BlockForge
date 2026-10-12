import {
  AddSubuserRequest,
  AuditQuery,
  ConsoleCommandRequest,
  CreateServerBase,
  CreateServerRequest,
  ServerActionRequest,
  ServerListQuery,
  UpdateDockerImageRequest,
  UpdateServerAllocationRequest,
  UpdateServerBuildRequest,
  UpdateServerSettingsRequest,
  UpdateStartupVariableRequest,
  UpdateSubuserRequest,
} from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { forbidden } from "../lib/errors.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";
import { hasPermissionAnywhere } from "../rbac/authorize.js";

const IdParams = z.object({ id: z.uuid() });
const SubuserParams = IdParams.extend({ subuserId: z.uuid() });
const AllocParams = IdParams.extend({ allocationId: z.uuid() });
const DeleteQuery = z.object({ deleteData: z.enum(["true", "false"]).default("false") });
const HistoryQuery = z.object({ lines: z.coerce.number().int().min(1).max(5000).default(500) });
const PreviewRequest = CreateServerBase.partial().extend({
  memoryLimitBytes: z.number().int().min(0).default(1024 ** 3),
  placement: CreateServerBase.shape.placement.default({ mode: "auto", preferTags: [] }),
});

export function registerServerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const s = ctx.servers;
  const access = ctx.serverAccess;

  app.get("/servers", async (req) => {
    const q = parse(ServerListQuery, req.query, "Query");
    return s.list(requirePrincipal(req), q);
  });

  app.post("/servers/placement-preview", async (req) => {
    const principal = requirePrincipal(req);
    if (!hasPermissionAnywhere(principal, "servers.create")) throw forbidden();
    const body = parse(PreviewRequest, req.body);
    const candidates = await s.placementPreview(principal, {
      memoryLimitBytes: body.memoryLimitBytes,
      cpuLimitMillicores: body.cpuLimitMillicores ?? null,
      storageQuotaBytes: body.storageQuotaBytes ?? null,
      placement: body.placement,
      allocation: body.allocation,
      overrideCapacity: body.overrideCapacity,
    });
    return { candidates };
  });

  app.post("/servers", async (req, reply) => {
    const principal = requirePrincipal(req);
    if (!hasPermissionAnywhere(principal, "servers.create")) throw forbidden();
    const body = parse(CreateServerRequest, req.body);
    return ctx.idempotency.handle(req, reply, "POST /servers", async () => ({ status: 202, body: await s.create(principal, body, actorOf(req)) }));
  });

  app.get("/servers/:id", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.view");
    return s.dto(a.server.id, a.principal);
  });

  app.patch("/servers/:id", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.settings.edit");
    return s.updateSettings(a, parse(UpdateServerSettingsRequest, req.body), actorOf(req));
  });

  app.patch("/servers/:id/build", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.admin");
    return s.updateBuild(a, parse(UpdateServerBuildRequest, req.body), actorOf(req));
  });

  app.post("/servers/:id/suspend", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.admin");
    return s.setSuspended(a, true, actorOf(req));
  });

  app.post("/servers/:id/unsuspend", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.admin");
    return s.setSuspended(a, false, actorOf(req));
  });

  app.post("/servers/:id/reinstall", async (req, reply) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.reinstall");
    return ctx.idempotency.handle(req, reply, "POST /servers/:id/reinstall", async () => ({ status: 202, body: await s.startOperation(a, "reinstall", {}, actorOf(req)) }));
  });

  app.delete("/servers/:id", async (req, reply) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.delete");
    const { deleteData } = parse(DeleteQuery, req.query, "Query");
    return ctx.idempotency.handle(req, reply, "DELETE /servers/:id", async () => ({
      status: 202,
      body: await s.startOperation(a, "delete", { deleteData: deleteData === "true" }, actorOf(req)),
    }));
  });

  app.post("/servers/:id/actions", async (req, reply) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.control");
    const body = parse(ServerActionRequest, req.body);
    const input = body.action === "stop" || body.action === "restart" ? { timeoutMs: body.timeoutMs ?? 60_000 } : {};
    return ctx.idempotency.handle(req, reply, "POST /servers/:id/actions", async () => ({ status: 202, body: await s.startOperation(a, body.action, input, actorOf(req)) }));
  });

  app.post("/servers/:id/console", async (req, reply) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.console.send");
    await s.sendConsole(a, parse(ConsoleCommandRequest, req.body).command, actorOf(req));
    return reply.status(204).send();
  });

  app.get("/servers/:id/console/history", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.console.view");
    const { lines } = parse(HistoryQuery, req.query, "Query");
    // Empty after a restart: pull the agent's recent output once.
    await ctx.consoleBackfill.ensure(a.server.id, lines);
    return ctx.consoles.tail(a.server.id, lines);
  });

  // --- Startup -----------------------------------------------------------------------
  app.get("/servers/:id/startup", async (req) => s.startup(await access.require(req, parse(IdParams, req.params, "Path").id, "servers.startup.view")));

  app.put("/servers/:id/startup/variables", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.startup.edit");
    const body = parse(UpdateStartupVariableRequest, req.body);
    return s.setVariable(a, body.envName, body.value, actorOf(req));
  });

  app.put("/servers/:id/startup/image", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.startup.image");
    return s.setImage(a, parse(UpdateDockerImageRequest, req.body).image, actorOf(req));
  });

  // --- Subusers -------------------------------------------------------------------------
  app.get("/servers/:id/subusers", async (req) => s.listSubusers(await access.require(req, parse(IdParams, req.params, "Path").id, "servers.subusers.view")));

  app.post("/servers/:id/subusers", async (req, reply) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.subusers.manage");
    reply.status(201);
    return s.addSubuser(a, parse(AddSubuserRequest, req.body), actorOf(req));
  });

  app.put("/servers/:id/subusers/:subuserId", async (req) => {
    const p = parse(SubuserParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.subusers.manage");
    return s.updateSubuser(a, p.subuserId, parse(UpdateSubuserRequest, req.body).permissions, actorOf(req));
  });

  app.delete("/servers/:id/subusers/:subuserId", async (req, reply) => {
    const p = parse(SubuserParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.subusers.manage");
    await s.removeSubuser(a, p.subuserId, actorOf(req));
    return reply.status(204).send();
  });

  // --- Activity -------------------------------------------------------------------------
  const ActivityCursor = z.object({ id: z.number().int().positive() });
  app.get("/servers/:id/activity", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.activity.view");
    const q = parse(AuditQuery, req.query, "Query");
    const cursor = decodeCursor(ActivityCursor, q.cursor);
    const page = await ctx.audit.list({
      limit: q.limit,
      targetType: "server",
      targetId: a.server.id,
      ...(cursor ? { beforeId: cursor.id } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
    });
    return { items: page.items, nextCursor: page.nextBeforeId ? encodeCursor({ id: page.nextBeforeId }) : null };
  });

  // --- Allocations (server side) ----------------------------------------------------------
  app.get("/servers/:id/allocations", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.allocations.view");
    return ctx.allocations.toDtos(await ctx.allocations.forServer(a.server.id));
  });

  app.post("/servers/:id/allocations", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.allocations.manage");
    const r = await ctx.allocations.assign(a.server.id, actorOf(req));
    ctx.serverState.notify(a.server.id);
    return r;
  });

  app.patch("/servers/:id/allocations/:allocationId", async (req) => {
    const p = parse(AllocParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.allocations.manage");
    const r = await ctx.allocations.updateForServer(a.server.id, p.allocationId, parse(UpdateServerAllocationRequest, req.body), actorOf(req));
    ctx.serverState.notify(a.server.id);
    return r;
  });

  app.delete("/servers/:id/allocations/:allocationId", async (req) => {
    const p = parse(AllocParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.allocations.manage");
    const r = await ctx.allocations.unassign(a.server.id, p.allocationId, actorOf(req));
    ctx.serverState.notify(a.server.id);
    return r;
  });
}
