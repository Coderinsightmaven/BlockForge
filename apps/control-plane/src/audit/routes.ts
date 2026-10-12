import { AuditQuery } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requirePermission } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";
import { GLOBAL } from "../rbac/authorize.js";

const AuditCursor = z.object({ id: z.number().int().positive() });

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/audit", async (req) => {
    await requirePermission(ctx.audit, req, "audit.view", GLOBAL);
    const q = parse(AuditQuery, req.query, "Query");
    const cursor = decodeCursor(AuditCursor, q.cursor);
    const page = await ctx.audit.list({
      limit: q.limit,
      ...(cursor ? { beforeId: cursor.id } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.targetType ? { targetType: q.targetType } : {}),
      ...(q.targetId ? { targetId: q.targetId } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
    });
    return { items: page.items, nextCursor: page.nextBeforeId ? encodeCursor({ id: page.nextBeforeId }) : null };
  });

  app.get("/audit/verify", async (req) => {
    await requirePermission(ctx.audit, req, "audit.view", GLOBAL);
    return ctx.audit.verify();
  });
}
