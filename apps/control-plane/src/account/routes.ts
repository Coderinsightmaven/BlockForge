import { CreateSshKeyRequest } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";

const KeyParams = z.object({ id: z.uuid() });

/** `/account/*`: the signed-in user's own settings (SSH keys for SFTP). */
export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/account/ssh-keys", async (req) => ctx.sshKeys.list(requirePrincipal(req).userId));

  app.post("/account/ssh-keys", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const body = parse(CreateSshKeyRequest, req.body);
    const key = await ctx.sshKeys.add(principal.userId, body, actorOf(req));
    reply.status(201);
    return key;
  });

  app.delete("/account/ssh-keys/:id", async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = parse(KeyParams, req.params, "Path");
    await ctx.sshKeys.remove(principal.userId, id, actorOf(req));
    return reply.status(204).send();
  });
}
