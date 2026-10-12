import { BackupStorageSettings, CreateBackupRequest, RestoreBackupRequest } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requesterBinding, requirePermission } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { AppError, badRequest } from "../lib/errors.js";
import { GLOBAL } from "../rbac/authorize.js";
import { StorageError, type BackupStorage } from "./storage.js";

const IdParams = z.object({ id: z.uuid() });
const BackupParams = IdParams.extend({ backupId: z.uuid() });
/** api.md `{name?, locked?}` (no contract schema yet — requested). */
const UpdateBackupRequest = z.object({ name: z.string().trim().min(1).max(120).optional(), locked: z.boolean().optional() });
const TestBody = z.object({ value: BackupStorageSettings.optional() }).default({});
const PutBody = z.object({ value: BackupStorageSettings });

/** `/servers/:id/backups…` and `/settings/backups.storage` (api.md "Backups"). */
export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const b = ctx.backups;
  const access = ctx.serverAccess;

  app.get("/servers/:id/backups", async (req) => b.list(await access.require(req, parse(IdParams, req.params, "Path").id, "servers.backups.view")));

  app.post("/servers/:id/backups", async (req, reply) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.backups.create");
    const body = parse(CreateBackupRequest, req.body ?? {});
    return ctx.idempotency.handle(req, reply, "POST /servers/:id/backups", async () => ({ status: 202, body: await b.create(a, body, actorOf(req)) }));
  });

  app.patch("/servers/:id/backups/:backupId", async (req) => {
    const p = parse(BackupParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.backups.delete");
    return b.update(a, p.backupId, parse(UpdateBackupRequest, req.body), actorOf(req));
  });

  app.delete("/servers/:id/backups/:backupId", async (req, reply) => {
    const p = parse(BackupParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.backups.delete");
    return reply.status(202).send(await b.remove(a, p.backupId, actorOf(req)));
  });

  app.get("/servers/:id/backups/:backupId/download", async (req) => {
    const p = parse(BackupParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.backups.download");
    return b.downloadUrl(a, p.backupId, requesterBinding(req), actorOf(req));
  });

  app.post("/servers/:id/backups/:backupId/restore", async (req, reply) => {
    const p = parse(BackupParams, req.params, "Path");
    const a = await access.require(req, p.id, "servers.backups.restore");
    const body = parse(RestoreBackupRequest, req.body ?? {});
    return ctx.idempotency.handle(req, reply, "POST /servers/:id/backups/:backupId/restore", async () => ({ status: 202, body: await b.restore(a, p.backupId, body, actorOf(req)) }));
  });

  // --- Storage settings (the S3 secret is write-only) ---------------------------------------
  app.get("/settings/backups.storage", async (req) => {
    await requirePermission(ctx.audit, req, "settings.manage", GLOBAL);
    return storageView(await ctx.backupStorage.view());
  });

  app.put("/settings/backups.storage", async (req) => {
    const principal = await requirePermission(ctx.audit, req, "settings.manage", GLOBAL);
    const { value } = parse(PutBody, req.body);
    try {
      await ctx.backupStorage.save(value, principal.userId);
    } catch (err) {
      if (err instanceof StorageError) throw badRequest(err.message);
      throw err;
    }
    const view = await ctx.backupStorage.view();
    // The audit trail records what changed, never the secret.
    await ctx.audit.record({ ...actorOf(req), action: "settings.update", targetType: "setting", targetId: "backups.storage", outcome: "success", details: { value: view, secretChanged: value.type === "s3" && Boolean(value.secretAccessKey) } });
    return storageView(view);
  });

  app.post("/settings/backups.storage/test", async (req) => {
    await requirePermission(ctx.audit, req, "settings.manage", GLOBAL);
    const body = parse(TestBody, req.body ?? {});
    let cfg;
    try {
      cfg = await ctx.backupStorage.resolveForTest(body.value);
    } catch (err) {
      if (err instanceof StorageError) return { ok: false, error: err.message };
      throw err;
    }
    if (cfg.type === "local") return { ok: true, error: null };
    try {
      return await ctx.backupStorage.test(cfg);
    } catch (err) {
      throw new AppError(502, "UPSTREAM_ERROR", (err as Error).message);
    }
  });
}

/** Contract `BackupStorageSettingsView`: the secret is never returned, only whether one is stored. */
function storageView(view: Awaited<ReturnType<BackupStorage["view"]>>) {
  const { secretAccessKeySet, ...value } = view as typeof view & { secretAccessKeySet?: boolean };
  return { key: "backups.storage" as const, value, secretAccessKeySet: secretAccessKeySet ?? false };
}
