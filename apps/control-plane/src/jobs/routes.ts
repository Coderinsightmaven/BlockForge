import { JobStatus, PageQuery } from "@blockforge/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePermission, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { forbidden, notFound } from "../lib/errors.js";
import { decodeCursor, encodeCursor, TimeIdCursor } from "../lib/pagination.js";
import type { Permission } from "@blockforge/contracts";
import { authorize, permittedScopes, type Resource } from "../rbac/authorize.js";

const IdParams = z.object({ id: z.uuid() });
const JobListQuery = PageQuery.extend({
  targetType: z.string().max(50).optional(),
  targetId: z.string().max(100).optional(),
  status: JobStatus.optional(),
});
const LogsQuery = z.object({ afterId: z.coerce.number().int().min(0).default(0) });

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function jobAndResource(req: FastifyRequest) {
    const { id } = parse(IdParams, req.params, "Path");
    const row = await ctx.jobs.getRow(id);
    if (!row) throw notFound("Job");
    const resource: Resource = (await ctx.rbac.resolve(row.targetType, row.targetId)) ?? { type: "global" };
    return { row, resource };
  }

  /** Server jobs: effective server permissions (roles ∪ ownership ∪ subuser); others: RBAC. */
  async function requireJobPermission(req: FastifyRequest, row: { targetType: string | null; targetId: string | null }, resource: Resource, permission: Permission) {
    if (row.targetType === "server" && row.targetId) {
      const principal = requirePrincipal(req);
      const perms = await ctx.serverAccess.permissionsOf(principal, row.targetId);
      if (perms) {
        if (perms.has(permission)) return;
        await requirePermission(ctx.audit, req, permission, resource);
        return;
      }
    }
    await requirePermission(ctx.audit, req, permission, resource);
  }

  app.get("/jobs", async (req) => {
    const principal = requirePrincipal(req);
    const q = parse(JobListQuery, req.query, "Query");
    const scopes = permittedScopes(principal, "jobs.view");
    let visible: { nodeIds: string[]; serverIds: string[] } | undefined;
    if (!scopes.all && !authorize(principal, "jobs.view", { type: "global" })) {
      const nodeIds = await ctx.rbac.visibleNodeIds(scopes);
      const serverIds = await ctx.rbac.visibleServerIds(scopes);
      const personal = principal.apiKey && !principal.apiKey.cap.has("jobs.view") ? [] : await ctx.serverAccess.personalServerIds(principal.userId, "jobs.view");
      visible = { nodeIds: nodeIds === "all" ? [] : nodeIds, serverIds: [...new Set([...(serverIds === "all" ? [] : serverIds), ...personal])] };
      if (!visible.nodeIds.length && !visible.serverIds.length) throw forbidden();
    }
    const page = await ctx.jobs.list({
      limit: q.limit,
      cursor: decodeCursor(TimeIdCursor, q.cursor),
      targetType: q.targetType,
      targetId: q.targetId,
      status: q.status,
      visible,
    });
    return { items: page.items, nextCursor: page.next ? encodeCursor(page.next) : null };
  });

  app.get("/jobs/:id", async (req) => {
    const { row, resource } = await jobAndResource(req);
    await requireJobPermission(req, row, resource, "jobs.view");
    return ctx.jobs.getDto(row.id);
  });

  app.get("/jobs/:id/logs", async (req) => {
    const { row, resource } = await jobAndResource(req);
    await requireJobPermission(req, row, resource, "jobs.view");
    return ctx.jobs.logs(row.id, parse(LogsQuery, req.query, "Query").afterId);
  });

  app.post("/jobs/:id/cancel", async (req, reply) => {
    const { row, resource } = await jobAndResource(req);
    const permission = ctx.jobs.definition(row.type)?.cancelPermission ?? "settings.manage";
    await requireJobPermission(req, row, resource, permission);
    return ctx.idempotency.handle(req, reply, "POST /jobs/:id/cancel", async () => {
      await ctx.jobs.cancel(row.id);
      await ctx.audit.record({ ...actorOf(req), action: "job.cancel", targetType: "job", targetId: row.id, outcome: "success", details: { type: row.type } });
      return { status: 200, body: await ctx.jobs.getDto(row.id) };
    });
  });
}
