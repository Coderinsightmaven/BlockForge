import { PlayerActionRequest, PlayerLookupQuery, PlayerSessionQuery } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";

const IdParams = z.object({ id: z.uuid() });

/** `/servers/:id/players…` (api.md "Players (Phase 4b)"). */
export function registerPlayerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const p = ctx.players;
  const access = ctx.serverAccess;

  app.get("/servers/:id/players", async (req) => p.overview(await access.require(req, parse(IdParams, req.params, "Path").id, "servers.players.view")));

  app.post("/servers/:id/players/actions", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.players.manage");
    return p.action(a, parse(PlayerActionRequest, req.body ?? {}), actorOf(req));
  });

  app.get("/servers/:id/players/lookup", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.players.view");
    return p.lookup(a, parse(PlayerLookupQuery, req.query, "Query").name);
  });

  app.get("/servers/:id/players/sessions", async (req) => {
    const a = await access.require(req, parse(IdParams, req.params, "Path").id, "servers.players.view");
    return p.sessions(a, parse(PlayerSessionQuery, req.query, "Query"));
  });
}
