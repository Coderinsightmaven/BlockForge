import {
  AddRoleBindingRequest,
  CreateUserRequest,
  PageQuery,
  ResetPasswordRequest,
  UpdateUserRequest,
} from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePermission } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { decodeCursor, encodeCursor, TimeIdCursor } from "../lib/pagination.js";
import { GLOBAL } from "../rbac/authorize.js";

const IdParams = z.object({ id: z.uuid() });
const BindingParams = z.object({ id: z.uuid(), bindingId: z.uuid() });

export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/users", async (req) => {
    await requirePermission(ctx.audit, req, "users.view", GLOBAL);
    const q = parse(PageQuery, req.query, "Query");
    const page = await ctx.users.list(q.limit, decodeCursor(TimeIdCursor, q.cursor));
    return { items: page.items, nextCursor: page.next ? encodeCursor(page.next) : null };
  });

  app.post("/users", async (req, reply) => {
    const actor = await requirePermission(ctx.audit, req, "users.manage", GLOBAL);
    const body = parse(CreateUserRequest, req.body);
    reply.status(201);
    return ctx.users.create(actor, actorOf(req), body);
  });

  app.get("/users/:id", async (req) => {
    await requirePermission(ctx.audit, req, "users.view", GLOBAL);
    return ctx.users.getDto(parse(IdParams, req.params, "Path").id);
  });

  app.patch("/users/:id", async (req) => {
    const actor = await requirePermission(ctx.audit, req, "users.manage", GLOBAL);
    const { id } = parse(IdParams, req.params, "Path");
    return ctx.users.update(actor, actorOf(req), id, parse(UpdateUserRequest, req.body));
  });

  app.post("/users/:id/password", async (req, reply) => {
    const actor = await requirePermission(ctx.audit, req, "users.manage", GLOBAL);
    const { id } = parse(IdParams, req.params, "Path");
    await ctx.users.resetPassword(actor, actorOf(req), id, parse(ResetPasswordRequest, req.body).password);
    return reply.status(204).send();
  });

  app.post("/users/:id/mfa/reset", async (req, reply) => {
    const actor = await requirePermission(ctx.audit, req, "users.manage", GLOBAL);
    await ctx.users.resetMfa(actor, actorOf(req), parse(IdParams, req.params, "Path").id);
    return reply.status(204).send();
  });

  app.post("/users/:id/roles", async (req) => {
    const actor = await requirePermission(ctx.audit, req, "users.manage", GLOBAL);
    const { id } = parse(IdParams, req.params, "Path");
    return ctx.users.addRole(actor, actorOf(req), id, parse(AddRoleBindingRequest, req.body));
  });

  app.delete("/users/:id/roles/:bindingId", async (req) => {
    const actor = await requirePermission(ctx.audit, req, "users.manage", GLOBAL);
    const { id, bindingId } = parse(BindingParams, req.params, "Path");
    return ctx.users.removeRole(actor, actorOf(req), id, bindingId);
  });

  app.get("/roles", async (req) => {
    await requirePermission(ctx.audit, req, "users.view", GLOBAL);
    return ctx.users.listRoles();
  });
}
