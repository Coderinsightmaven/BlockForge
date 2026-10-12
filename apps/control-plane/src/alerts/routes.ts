import { AlertIncident, UpsertAlertRuleRequest, UpsertNotificationChannelRequest } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePermission, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { forbidden } from "../lib/errors.js";
import { decodeCursor, encodeCursor, TimeIdCursor } from "../lib/pagination.js";
import { incidentScopeFilter } from "./scope.js";
import { authorize, GLOBAL, hasPermissionAnywhere, permittedScopes, type Resource } from "../rbac/authorize.js";

const IdParams = z.object({ id: z.uuid() });
const IncidentQuery = z.object({
  status: z.union([AlertIncident.shape.status, z.literal("open")]).optional(),
  severity: AlertIncident.shape.severity.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

export function registerAlertRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** The resource a rule is scoped to (alerts.manage is checked there). */
  async function ruleScope(rule: { scopeType: string; scopeId: string | null }): Promise<Resource> {
    if (rule.scopeType === "server" && rule.scopeId) return ctx.rbac.serverOrThrow(rule.scopeId);
    if (rule.scopeType === "node" && rule.scopeId) return { type: "node", id: rule.scopeId };
    return GLOBAL;
  }

  // --- Incidents -------------------------------------------------------------------
  app.get("/alerts/incidents", async (req) => {
    const principal = requirePrincipal(req);
    if (!hasPermissionAnywhere(principal, "alerts.view")) throw forbidden();
    const q = parse(IncidentQuery, req.query, "Query");
    // Scope filtering happens in SQL: one page query, no per-incident lookups.
    const scopes = permittedScopes(principal, "alerts.view");
    const nodeIds = await ctx.rbac.visibleNodeIds(scopes);
    const serverIds = await ctx.rbac.visibleServerIds(scopes);
    const page = await ctx.alerts.listIncidents({
      status: q.status,
      severity: q.severity,
      limit: q.limit,
      cursor: decodeCursor(TimeIdCursor, q.cursor),
      scope: incidentScopeFilter(nodeIds, serverIds),
    });
    return { items: await ctx.alerts.incidentDtos(page.rows), nextCursor: page.next ? encodeCursor(page.next) : null };
  });

  app.post("/alerts/incidents/:id/ack", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    const row = await ctx.alerts.incidentRow(id);
    await requirePermission(ctx.audit, req, "alerts.manage", await ctx.alerts.subjectResource(row.subjectType, row.subjectId));
    return ctx.alerts.acknowledge(id, actorOf(req));
  });

  app.post("/alerts/incidents/:id/resolve", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    const row = await ctx.alerts.incidentRow(id);
    await requirePermission(ctx.audit, req, "alerts.manage", await ctx.alerts.subjectResource(row.subjectType, row.subjectId));
    return ctx.alerts.resolveManually(id, actorOf(req));
  });

  // --- Rules -------------------------------------------------------------------------
  app.get("/alerts/rules", async (req) => {
    const principal = requirePrincipal(req);
    if (!hasPermissionAnywhere(principal, "alerts.view")) throw forbidden();
    const rules = await ctx.alerts.listRules();
    const out = [];
    for (const r of rules) {
      // A rule is visible to holders of alerts.view at its scope; global rules need global scope.
      // Rules scoped to a server that no longer exists are only shown to global viewers.
      const scope = await ruleScope(r).catch(() => GLOBAL);
      if (authorize(principal, "alerts.view", scope)) out.push(r);
    }
    return out;
  });

  app.post("/alerts/rules", async (req, reply) => {
    const body = parse(UpsertAlertRuleRequest, req.body);
    await requirePermission(ctx.audit, req, "alerts.manage", await ruleScope(body));
    reply.status(201);
    return ctx.alerts.createRule(body, actorOf(req));
  });

  app.put("/alerts/rules/:id", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    const body = parse(UpsertAlertRuleRequest, req.body);
    const existing = await ctx.alerts.getRule(id);
    await requirePermission(ctx.audit, req, "alerts.manage", await ruleScope(existing));
    await requirePermission(ctx.audit, req, "alerts.manage", await ruleScope(body));
    return ctx.alerts.updateRule(id, body, actorOf(req));
  });

  app.delete("/alerts/rules/:id", async (req, reply) => {
    const { id } = parse(IdParams, req.params, "Path");
    const existing = await ctx.alerts.getRule(id);
    await requirePermission(ctx.audit, req, "alerts.manage", await ruleScope(existing));
    await ctx.alerts.deleteRule(id, actorOf(req));
    return reply.status(204).send();
  });

  // --- Notification channels (global objects) ------------------------------------------
  app.get("/notification-channels", async (req) => {
    await requirePermission(ctx.audit, req, "alerts.manage", GLOBAL);
    return ctx.notifications.list();
  });

  app.post("/notification-channels", async (req, reply) => {
    await requirePermission(ctx.audit, req, "alerts.manage", GLOBAL);
    const body = parse(UpsertNotificationChannelRequest, req.body);
    reply.status(201);
    return ctx.notifications.create(body, actorOf(req));
  });

  app.put("/notification-channels/:id", async (req) => {
    await requirePermission(ctx.audit, req, "alerts.manage", GLOBAL);
    const { id } = parse(IdParams, req.params, "Path");
    return ctx.notifications.update(id, parse(UpsertNotificationChannelRequest, req.body), actorOf(req));
  });

  app.delete("/notification-channels/:id", async (req, reply) => {
    await requirePermission(ctx.audit, req, "alerts.manage", GLOBAL);
    await ctx.notifications.remove(parse(IdParams, req.params, "Path").id, actorOf(req));
    return reply.status(204).send();
  });

  app.post("/notification-channels/:id/test", async (req) => {
    await requirePermission(ctx.audit, req, "alerts.manage", GLOBAL);
    return ctx.notifications.test(parse(IdParams, req.params, "Path").id, actorOf(req));
  });
}
