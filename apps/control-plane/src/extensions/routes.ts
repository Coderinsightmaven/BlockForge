import {
  ApplyExtensionUpdatesRequest,
  CompleteExtensionUploadRequest,
  EXTENSIONS_MANAGE_PERMISSION,
  EXTENSIONS_READ_PERMISSION,
  ExtensionHistoryQuery,
  ExtensionUpdatesQuery,
  ExtensionUploadRequest,
  ModrinthInstallRequest,
  ModrinthPlanRequest,
  ModrinthProjectQuery,
  ModrinthProjectRef,
  ModrinthSearchQuery,
  ScanExtensionsRequest,
  UpdateExtensionRequest,
} from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requesterBinding } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";

const IdParams = z.object({ id: z.uuid() });
const ExtParams = IdParams.extend({ extensionId: z.uuid() });
const ProjectParams = IdParams.extend({ project: ModrinthProjectRef });
const UploadParams = IdParams.extend({ uploadId: z.uuid() });
const EntryParams = IdParams.extend({ entryId: z.uuid() });
/** Not (yet) in the contract: beta/alpha versions in the project's version list (default false, as for plans/updates). */

/** `/servers/:id/extensions…` (api.md "Plugins & mods (Phase 4b)"). */
export function registerExtensionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const x = ctx.extensions;
  const access = ctx.serverAccess;
  const read = (req: Parameters<typeof access.require>[0], id: string) => access.require(req, id, EXTENSIONS_READ_PERMISSION);
  const manage = (req: Parameters<typeof access.require>[0], id: string) => access.require(req, id, EXTENSIONS_MANAGE_PERMISSION);

  app.get("/servers/:id/extensions", async (req) => x.list(await read(req, parse(IdParams, req.params, "Path").id)));

  app.post("/servers/:id/extensions/scan", async (req, reply) => {
    const a = await manage(req, parse(IdParams, req.params, "Path").id);
    const body = parse(ScanExtensionsRequest, req.body ?? {});
    return ctx.idempotency.handle(req, reply, "POST /servers/:id/extensions/scan", async () => ({ status: 202, body: await x.scan(a, body.full, actorOf(req)) }));
  });

  app.get("/servers/:id/extensions/modrinth/search", async (req) => {
    const a = await read(req, parse(IdParams, req.params, "Path").id);
    return x.search(a, parse(ModrinthSearchQuery, req.query, "Query"));
  });

  app.get("/servers/:id/extensions/modrinth/projects/:project", async (req) => {
    const p = parse(ProjectParams, req.params, "Path");
    return x.project(await read(req, p.id), p.project, parse(ModrinthProjectQuery, req.query, "Query").allowPrerelease);
  });

  app.post("/servers/:id/extensions/modrinth/plan", async (req) => {
    const a = await read(req, parse(IdParams, req.params, "Path").id);
    return x.plan(a, parse(ModrinthPlanRequest, req.body ?? {}));
  });

  app.post("/servers/:id/extensions/modrinth/install", async (req, reply) => {
    const a = await manage(req, parse(IdParams, req.params, "Path").id);
    const body = parse(ModrinthInstallRequest, req.body ?? {});
    return ctx.idempotency.handle(req, reply, "POST /servers/:id/extensions/modrinth/install", async () => ({ status: 202, body: await x.install(a, body, actorOf(req)) }));
  });

  app.get("/servers/:id/extensions/updates", async (req) => {
    const a = await read(req, parse(IdParams, req.params, "Path").id);
    return x.updates(a, parse(ExtensionUpdatesQuery, req.query, "Query").allowPrerelease);
  });

  app.post("/servers/:id/extensions/updates/apply", async (req, reply) => {
    const a = await manage(req, parse(IdParams, req.params, "Path").id);
    const body = parse(ApplyExtensionUpdatesRequest, req.body ?? {});
    return ctx.idempotency.handle(req, reply, "POST /servers/:id/extensions/updates/apply", async () => ({ status: 202, body: await x.applyUpdates(a, body, actorOf(req)) }));
  });

  app.post("/servers/:id/extensions/uploads", async (req) => {
    const a = await manage(req, parse(IdParams, req.params, "Path").id);
    return x.createUpload(a, parse(ExtensionUploadRequest, req.body ?? {}), requesterBinding(req), actorOf(req));
  });

  app.post("/servers/:id/extensions/uploads/:uploadId/complete", async (req) => {
    const p = parse(UploadParams, req.params, "Path");
    return x.completeUpload(await manage(req, p.id), p.uploadId, parse(CompleteExtensionUploadRequest, req.body ?? {}), actorOf(req));
  });

  app.get("/servers/:id/extensions/history", async (req) => {
    const a = await read(req, parse(IdParams, req.params, "Path").id);
    return x.history(a, parse(ExtensionHistoryQuery, req.query, "Query"));
  });

  app.post("/servers/:id/extensions/history/:entryId/rollback", async (req, reply) => {
    const p = parse(EntryParams, req.params, "Path");
    const a = await manage(req, p.id);
    return ctx.idempotency.handle(req, reply, "POST /servers/:id/extensions/history/:entryId/rollback", async () => ({ status: 202, body: await x.rollback(a, p.entryId, actorOf(req)) }));
  });

  app.get("/servers/:id/extensions/:extensionId", async (req) => {
    const p = parse(ExtParams, req.params, "Path");
    return x.get(await read(req, p.id), p.extensionId);
  });

  app.patch("/servers/:id/extensions/:extensionId", async (req) => {
    const p = parse(ExtParams, req.params, "Path");
    return x.setEnabled(await manage(req, p.id), p.extensionId, parse(UpdateExtensionRequest, req.body ?? {}).enabled, actorOf(req));
  });

  app.delete("/servers/:id/extensions/:extensionId", async (req) => {
    const p = parse(ExtParams, req.params, "Path");
    return x.remove(await manage(req, p.id), p.extensionId, actorOf(req));
  });
}
