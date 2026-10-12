import { CronPreviewRequest, PageQuery, UpsertScheduleRequest } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";

const IdParams = z.object({ id: z.uuid() });
const ScheduleParams = IdParams.extend({ scheduleId: z.uuid() });

/** `/servers/:id/schedules…` and `/schedules/preview` (api.md "Schedules"). */
export function registerScheduleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const s = ctx.schedules;
  const access = ctx.serverAccess;

  app.get("/servers/:id/schedules", async (req) => s.list(await access.require(req, parse(IdParams, req.params, "Path").id, "schedules.view")));

  app.post("/servers/:id/schedules", async (req, reply) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "schedules.manage");
    reply.status(201);
    return s.create(a, parse(UpsertScheduleRequest, req.body), actorOf(req));
  });

  app.get("/servers/:id/schedules/:scheduleId", async (req) => {
    const p = parse(ScheduleParams, req.params, "Path");
    return s.get(await access.require(req, p.id, "schedules.view"), p.scheduleId);
  });

  app.put("/servers/:id/schedules/:scheduleId", async (req) => {
    const p = parse(ScheduleParams, req.params, "Path");
    const a = await access.require(req, p.id, "schedules.manage");
    return s.update(a, p.scheduleId, parse(UpsertScheduleRequest, req.body), actorOf(req));
  });

  app.delete("/servers/:id/schedules/:scheduleId", async (req, reply) => {
    const p = parse(ScheduleParams, req.params, "Path");
    await s.remove(await access.require(req, p.id, "schedules.manage"), p.scheduleId, actorOf(req));
    return reply.status(204).send();
  });

  app.post("/servers/:id/schedules/:scheduleId/run", async (req, reply) => {
    const p = parse(ScheduleParams, req.params, "Path");
    const a = await access.require(req, p.id, "schedules.manage");
    reply.status(202);
    return s.runNow(a, p.scheduleId, actorOf(req));
  });

  app.get("/servers/:id/schedules/:scheduleId/runs", async (req) => {
    const p = parse(ScheduleParams, req.params, "Path");
    const a = await access.require(req, p.id, "schedules.view");
    const q = parse(PageQuery, req.query, "Query");
    return s.runs(a, p.scheduleId, { limit: q.limit, cursor: q.cursor });
  });

  app.post("/schedules/preview", async (req) => {
    requirePrincipal(req);
    const body = parse(CronPreviewRequest, req.body);
    return s.preview(body.cron, body.timezone, body.count);
  });
}
