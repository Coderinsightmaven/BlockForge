import { AllocationListQuery, CreateAllocationsRequest, UpdateAllocationRequest } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePermission } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";

const IdParams = z.object({ id: z.uuid() });

/** Node allocation pools (`/nodes/:id/allocations`, `/allocations/:id`). */
export function registerAllocationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/nodes/:id/allocations", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    await requirePermission(ctx.audit, req, "nodes.view", { type: "node", id });
    await ctx.nodes.row(id);
    return ctx.allocations.listForNode(id, parse(AllocationListQuery, req.query, "Query"));
  });

  app.post("/nodes/:id/allocations", async (req, reply) => {
    const { id } = parse(IdParams, req.params, "Path");
    await requirePermission(ctx.audit, req, "allocations.manage", { type: "node", id });
    const r = await ctx.allocations.create(id, parse(CreateAllocationsRequest, req.body), actorOf(req));
    reply.status(201);
    return r;
  });

  app.patch("/allocations/:id", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    const row = await ctx.allocations.row(id);
    await requirePermission(ctx.audit, req, "allocations.manage", { type: "node", id: row.nodeId });
    return ctx.allocations.update(id, parse(UpdateAllocationRequest, req.body), actorOf(req));
  });

  app.delete("/allocations/:id", async (req, reply) => {
    const { id } = parse(IdParams, req.params, "Path");
    const row = await ctx.allocations.row(id);
    await requirePermission(ctx.audit, req, "allocations.manage", { type: "node", id: row.nodeId });
    await ctx.allocations.remove(id, actorOf(req));
    return reply.status(204).send();
  });
}
