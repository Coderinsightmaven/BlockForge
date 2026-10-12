import { METRIC_SERIES, MetricRangeQuery } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requirePermission, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { badRequest, forbidden } from "../lib/errors.js";
import { authorize, hasPermissionAnywhere, permittedScopes } from "../rbac/authorize.js";

export function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/metrics/range", async (req) => {
    const q = parse(MetricRangeQuery, req.query, "Query");
    const scope = METRIC_SERIES[q.series].scope;
    const range = { series: q.series, from: q.from, to: q.to, stepMs: q.stepMs };
    if (scope === "node") {
      if (!q.nodeId) throw badRequest("nodeId is required for node series");
      await requirePermission(ctx.audit, req, "monitoring.view", { type: "node", id: q.nodeId });
      return ctx.metricsQuery.range(range, { nodeId: q.nodeId });
    }
    if (scope === "server") {
      if (!q.serverId) throw badRequest("serverId is required for server series");
      await requirePermission(ctx.audit, req, "monitoring.view", await ctx.rbac.serverOrThrow(q.serverId));
      return ctx.metricsQuery.range(range, { serverId: q.serverId });
    }
    // global.*: aggregate over every node the user can see.
    const principal = requirePrincipal(req);
    if (authorize(principal, "monitoring.view", { type: "global" })) return ctx.metricsQuery.range(range, { nodeIds: "all" });
    const scopes = permittedScopes(principal, "monitoring.view");
    if (!hasPermissionAnywhere(principal, "monitoring.view")) throw forbidden();
    const serverIds = await ctx.rbac.visibleServerIds(scopes);
    return ctx.metricsQuery.range(range, { nodeIds: [...scopes.nodeIds], serverIds });
  });

  app.get("/overview", async (req) => {
    const principal = requirePrincipal(req);
    if (!hasPermissionAnywhere(principal, "monitoring.view")) throw forbidden();
    return ctx.overview.summary(principal);
  });
}
