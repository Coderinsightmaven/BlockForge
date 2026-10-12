import { AGENT_COMMANDS, CreateEnrollmentTokenRequest, IDEMPOTENCY_HEADER, UpdateNodeRequest } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { commandErrorToHttp } from "../agents/errors.js";
import type { AppContext } from "../context.js";
import { actorOf, requirePermission, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { ROTATE_CREDENTIALS_JOB } from "../jobs/builtin/rotate-credentials.js";
import { badRequest, forbidden, invalidState } from "../lib/errors.js";
import { GLOBAL, permittedScopes } from "../rbac/authorize.js";

const IdParams = z.object({ id: z.uuid() });

export function registerNodeRoutes(app: FastifyInstance, ctx: AppContext): void {
  // --- Enrollment tokens (static paths take precedence over /nodes/:id) ---------
  app.get("/nodes/enrollment-tokens", async (req) => {
    await requirePermission(ctx.audit, req, "nodes.enroll", GLOBAL);
    return ctx.enrollment.list();
  });

  app.post("/nodes/enrollment-tokens", async (req, reply) => {
    await requirePermission(ctx.audit, req, "nodes.enroll", GLOBAL);
    const body = parse(CreateEnrollmentTokenRequest, req.body);
    reply.status(201);
    return ctx.enrollment.create(body, actorOf(req));
  });

  app.delete("/nodes/enrollment-tokens/:id", async (req, reply) => {
    await requirePermission(ctx.audit, req, "nodes.enroll", GLOBAL);
    await ctx.enrollment.remove(parse(IdParams, req.params, "Path").id, actorOf(req));
    return reply.status(204).send();
  });

  // --- Nodes ----------------------------------------------------------------------
  app.get("/nodes", async (req) => {
    const principal = requirePrincipal(req);
    const scopes = permittedScopes(principal, "nodes.view");
    if (!scopes.all && scopes.nodeIds.size === 0) throw forbidden();
    return ctx.nodes.toDtos(await ctx.nodes.rows(scopes.all ? "all" : [...scopes.nodeIds]));
  });

  app.get("/nodes/:id", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    await requirePermission(ctx.audit, req, "nodes.view", { type: "node", id });
    return ctx.nodes.get(id);
  });

  app.patch("/nodes/:id", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    await requirePermission(ctx.audit, req, "nodes.manage", { type: "node", id });
    return ctx.nodes.update(id, parse(UpdateNodeRequest, req.body), actorOf(req));
  });

  app.post("/nodes/:id/approve", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    await requirePermission(ctx.audit, req, "nodes.manage", { type: "node", id });
    return ctx.nodes.approve(id, actorOf(req));
  });

  app.post("/nodes/:id/revoke", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    await requirePermission(ctx.audit, req, "nodes.manage", { type: "node", id });
    return ctx.nodes.revoke(id, actorOf(req));
  });

  /**
   * Starts a `node.credentials.rotate` job → `RotateCredentialsResponse {node, jobId}` (the job id
   * is also in `x-blockforge-job-id`). An `Idempotency-Key` maps to the same job on retries.
   */
  app.post("/nodes/:id/rotate-credentials", async (req, reply) => {
    const { id } = parse(IdParams, req.params, "Path");
    const principal = await requirePermission(ctx.audit, req, "nodes.manage", { type: "node", id });
    const row = await ctx.nodes.row(id);
    if (!["active", "draining", "maintenance"].includes(row.status)) throw invalidState(`Cannot rotate credentials of a ${row.status} node`);
    const key = req.headers[IDEMPOTENCY_HEADER];
    const idemKey = typeof key === "string" ? key : null;
    if (idemKey !== null && !/^[\x21-\x7e]{1,128}$/.test(idemKey)) throw badRequest("Idempotency-Key must be 1–128 printable ASCII characters");
    const jobId = await ctx.jobs.enqueue(
      ROTATE_CREDENTIALS_JOB,
      { nodeId: id },
      {
        targetType: "node",
        targetId: id,
        requestedBy: principal.userId,
        idempotencyKey: idemKey ? `${principal.userId}:rotate-credentials:${id}:${idemKey}` : null,
      },
    );
    await ctx.audit.record({ ...actorOf(req), action: "node.credentials.rotate", targetType: "node", targetId: id, outcome: "success", details: { jobId } });
    reply.header("x-blockforge-job-id", jobId);
    reply.status(202);
    return { node: await ctx.nodes.get(id), jobId };
  });

  app.delete("/nodes/:id", async (req, reply) => {
    const { id } = parse(IdParams, req.params, "Path");
    await requirePermission(ctx.audit, req, "nodes.manage", { type: "node", id });
    await ctx.nodes.remove(id, actorOf(req));
    return reply.status(204).send();
  });

  const ProbeBody = AGENT_COMMANDS["node.probe"].payload;
  app.post("/nodes/:id/probe", async (req) => {
    const { id } = parse(IdParams, req.params, "Path");
    const principal = await requirePermission(ctx.audit, req, "nodes.manage", { type: "node", id });
    const body = parse(ProbeBody, req.body);
    await ctx.nodes.row(id);
    try {
      return await ctx.gateway.send(id, "node.probe", body, { userId: principal.userId, timeoutMs: body.timeoutMs + 5000 });
    } catch (err) {
      throw commandErrorToHttp(err);
    }
  });
}
