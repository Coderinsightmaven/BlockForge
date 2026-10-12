import { ImportTemplateRequest, ServerSoftware, UpdateTemplateRequest } from "@blockforge/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePermission, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { forbidden } from "../lib/errors.js";
import { authorize, GLOBAL, hasPermissionAnywhere } from "../rbac/authorize.js";

const IdParams = z.object({ id: z.uuid() });
const SoftwareParams = z.object({ software: ServerSoftware });
const VersionParams = SoftwareParams.extend({ version: z.string().min(1).max(64) });
const BuildParams = VersionParams.extend({ build: z.string().min(1).max(64) });

export function registerTemplateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const canBrowse = (req: FastifyRequest) => {
    const p = requirePrincipal(req);
    if (!authorize(p, "templates.view", GLOBAL) && !hasPermissionAnywhere(p, "servers.create")) throw forbidden();
  };

  app.get("/templates", async (req) => {
    canBrowse(req);
    return ctx.templates.listSummaries();
  });

  app.get("/templates/:id", async (req) => {
    await requirePermission(ctx.audit, req, "templates.view", GLOBAL);
    return ctx.templates.get(parse(IdParams, req.params, "Path").id);
  });

  app.post("/templates/import/preview", async (req) => {
    await requirePermission(ctx.audit, req, "templates.manage", GLOBAL);
    return ctx.templates.preview(parse(ImportTemplateRequest, req.body));
  });

  app.post("/templates/import", async (req, reply) => {
    await requirePermission(ctx.audit, req, "templates.manage", GLOBAL);
    const result = await ctx.templates.import(parse(ImportTemplateRequest, req.body), actorOf(req));
    reply.status(201);
    return result;
  });

  app.patch("/templates/:id", async (req) => {
    await requirePermission(ctx.audit, req, "templates.manage", GLOBAL);
    return ctx.templates.update(parse(IdParams, req.params, "Path").id, parse(UpdateTemplateRequest, req.body), actorOf(req));
  });

  app.delete("/templates/:id", async (req, reply) => {
    await requirePermission(ctx.audit, req, "templates.manage", GLOBAL);
    await ctx.templates.remove(parse(IdParams, req.params, "Path").id, actorOf(req));
    return reply.status(204).send();
  });

  app.get("/templates/:id/export", async (req, reply) => {
    await requirePermission(ctx.audit, req, "templates.manage", GLOBAL);
    const egg = await ctx.templates.export(parse(IdParams, req.params, "Path").id);
    reply.header("content-disposition", `attachment; filename="egg-${String((egg as { name?: unknown }).name ?? "template").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60)}.json"`);
    return egg;
  });

  // --- Catalogue --------------------------------------------------------------------------
  const catalogAccess = (req: FastifyRequest) => {
    const p = requirePrincipal(req);
    if (!hasPermissionAnywhere(p, "servers.create") && !hasPermissionAnywhere(p, "servers.view")) throw forbidden();
  };

  app.get("/catalog/software", async (req) => {
    catalogAccess(req);
    return ctx.catalog.info();
  });

  app.get("/catalog/software/:software/versions", async (req) => {
    catalogAccess(req);
    return ctx.catalog.versions(parse(SoftwareParams, req.params, "Path").software);
  });

  app.get("/catalog/software/:software/versions/:version/builds", async (req) => {
    catalogAccess(req);
    const p = parse(VersionParams, req.params, "Path");
    return ctx.catalog.builds(p.software, p.version);
  });

  app.get("/catalog/software/:software/versions/:version/builds/:build/plan", async (req) => {
    catalogAccess(req);
    const p = parse(BuildParams, req.params, "Path");
    return ctx.catalog.plan(p.software, p.version, p.build);
  });
}
